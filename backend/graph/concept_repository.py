"""
graph/concept_repository.py
All Cypher queries for (:Concept) nodes and typed relationship edges.

Graph schema managed here
--------------------------
Nodes
    (:Concept {name, doc_id, mention_count})
        name          : Normalised entity string e.g. "Great Bath"
        doc_id        : Document this concept was extracted from
        mention_count : How many triples reference this concept (auto-incremented)

Relationships  (dynamically typed from Triple.relation)
    (:Concept)-[:LOCATED_IN]->(:Concept)
    (:Concept)-[:USED_FOR]->(:Concept)
    (:Concept)-[:DISCOVERED_BY]->(:Concept)
    ... any UPPER_SNAKE_CASE relation from the extractor

    (:Chunk)-[:MENTIONS]->(:Concept)
        Links each source chunk to the concepts it contains — used by
        question generation to find which chunks discuss a given concept.

Nothing in this file knows about Groq, ingestion, or chunking.
"""

import logging
from collections import defaultdict

from neo4j import Session

from graph.concept_extractor import Triple

logger = logging.getLogger(__name__)

_BATCH_SIZE = 100


class ConceptRepository:
    """
    Data-access object for (:Concept) nodes and concept relationships.

    Usage
    -----
        with client.session() as session:
            repo = ConceptRepository(session)
            repo.upsert_triples(triples)
    """

    def __init__(self, session: Session):
        self._session = session

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------

    def upsert_triples(self, triples: list[Triple]) -> None:
        """
        Write all triples for a document to Neo4j.

        Order of operations (each step depends on the previous):
          1. Upsert all unique Concept nodes (subject + object entities).
          2. Create typed relationship edges between concept pairs.
          3. Create (:Chunk)-[:MENTIONS]->(:Concept) edges.

        All operations use MERGE so the full method is idempotent —
        safe to call multiple times on the same document.

        Args:
            triples: List of Triple objects from ConceptExtractor.
        """
        if not triples:
            logger.warning("upsert_triples called with empty list.")
            return

        logger.info("Writing %d triples to Neo4j ...", len(triples))

        self._upsert_concept_nodes(triples)
        self._upsert_concept_relations(triples)
        self._upsert_chunk_mentions(triples)

        logger.info("Concept graph write complete.")

    def delete_for_document(self, doc_id: str) -> None:
        """
        Delete all Concept nodes and concept relationships for a document.
        Called before re-extracting concepts on re-ingestion.

        Note: only deletes concepts that are EXCLUSIVELY referenced by
        this document. Shared concepts (mentioned in multiple docs) are
        preserved — their mention_count is decremented instead.
        """
        # Decrement mention counts for shared concepts
        self._session.run(
            """
            MATCH (c:Concept {doc_id: $doc_id})
            SET c.mention_count = c.mention_count - 1
            WITH c WHERE c.mention_count <= 0
            DETACH DELETE c
            """,
            doc_id=doc_id,
        )
        logger.info("Cleaned concept nodes for doc_id='%s'.", doc_id)

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def find_neighbours_by_distance(
        self, concept_name: str, doc_id: str, max_hops: int = 2
    ) -> list[dict]:
        """
        Return concept neighbours grouped by hop distance from concept_name.
        Used by MCQ distractor selection — closer nodes = harder distractors.

        Returns list of {name, distance, relation} sorted by distance ascending.
        Distance 1 = directly related (hardest distractor).
        Distance 2 = two hops away (medium distractor).
        Distance 3 = three hops away — may be off-topic; caller should
                     semantically filter these before use.

        The `relation` field carries the type of the FIRST edge on the path
        (e.g. LOCATED_IN, PART_OF) so the caller can assess topic relevance
        without an extra round-trip.
        """
        query = f"""
        MATCH (start:Concept {{name: $concept_name, doc_id: $doc_id}})
        MATCH path = (start)-[*1..{int(max_hops)}]-(neighbour:Concept {{doc_id: $doc_id}})
        WHERE start <> neighbour
        WITH DISTINCT
            neighbour.name AS name,
            length(path)   AS distance,
            type(relationships(path)[0]) AS relation
        ORDER BY distance ASC
        RETURN name, distance, relation
        """

        result = self._session.run(
            query,
            concept_name=concept_name,
            doc_id=doc_id,
        )
        return [
            {"name": r["name"], "distance": r["distance"], "relation": r["relation"]}
            for r in result
        ]

    def find_concepts_for_document(self, doc_id: str) -> list[dict]:
        """Return all Concept nodes for a document, sorted by mention count."""
        result = self._session.run(
            """
            MATCH (c:Concept {doc_id: $doc_id})
            RETURN c
            ORDER BY c.mention_count DESC
            """,
            doc_id=doc_id,
        )
        return [dict(r["c"]) for r in result]

    def find_relations_for_document(self, doc_id: str) -> list[dict]:
        """
        Return all concept relationships for a document as
        {subject, relation, object} dicts — used by question generation.
        """
        result = self._session.run(
            """
            MATCH (a:Concept {doc_id: $doc_id})-[r]->(b:Concept {doc_id: $doc_id})
            WHERE type(r) <> 'MENTIONS'
            RETURN a.name AS subject, type(r) AS relation, b.name AS object
            ORDER BY a.name
            """,
            doc_id=doc_id,
        )
        return [dict(r) for r in result]

    def find_chunks_for_concept(self, concept_name: str, doc_id: str) -> list[str]:
        """
        Return chunk_ids that mention a given concept.
        Used by question generation to pull relevant chunks for a concept.
        """
        result = self._session.run(
            """
            MATCH (ch:Chunk)-[:MENTIONS]->(c:Concept {doc_id: $doc_id})
            WHERE toLower(c.name) = toLower($name)
            RETURN ch.chunk_id AS chunk_id
            """,
            doc_id=doc_id,
            name=concept_name,
        )
        return [r["chunk_id"] for r in result]

    # ------------------------------------------------------------------
    # Internal write helpers
    # ------------------------------------------------------------------

    def _upsert_concept_nodes(self, triples: list[Triple]) -> None:
        """
        Upsert one (:Concept) node per unique entity across all triples.
        mention_count tracks how many triples reference this concept.
        """
        # Count mentions per (doc_id, name) pair
        counts: dict[tuple[str, str], int] = defaultdict(int)
        for t in triples:
            counts[(t.doc_id, t.subject)] += 1
            counts[(t.doc_id, t.object_)] += 1

        nodes = [
            {"name": name, "doc_id": doc_id, "count": cnt}
            for (doc_id, name), cnt in counts.items()
        ]

        for start in range(0, len(nodes), _BATCH_SIZE):
            batch = nodes[start : start + _BATCH_SIZE]
            self._session.run(
                """
                UNWIND $nodes AS n
                MERGE (c:Concept {name: n.name, doc_id: n.doc_id})
                ON CREATE SET c.mention_count = n.count
                ON MATCH  SET c.mention_count = c.mention_count + n.count
                """,
                nodes=batch,
            )

        logger.debug("Upserted %d unique concept node(s).", len(nodes))

    def _upsert_concept_relations(self, triples: list[Triple]) -> None:
        """
        Create typed relationship edges between concept pairs.

        Neo4j does not allow dynamic relationship types in a single
        parameterised query, so we group triples by relation type and
        issue one UNWIND query per type. This is efficient because most
        documents have fewer than 10-15 distinct relation types.
        """
        # Group by relation type
        by_relation: dict[str, list[dict]] = defaultdict(list)
        for t in triples:
            by_relation[t.relation].append({
                "subject": t.subject,
                "object": t.object_,
                "doc_id": t.doc_id,
            })

        for rel_type, pairs in by_relation.items():
            # Validate relation type is safe to interpolate into Cypher
            if not rel_type.replace("_", "").isalnum():
                logger.warning("Skipping unsafe relation type: %s", rel_type)
                continue

            for start in range(0, len(pairs), _BATCH_SIZE):
                batch = pairs[start : start + _BATCH_SIZE]
                self._session.run(
                    f"""
                    UNWIND $pairs AS p
                    MATCH (a:Concept {{name: p.subject, doc_id: p.doc_id}})
                    MATCH (b:Concept {{name: p.object,  doc_id: p.doc_id}})
                    MERGE (a)-[:{rel_type}]->(b)
                    """,
                    pairs=batch,
                )

        logger.debug(
            "Upserted relationships for %d relation type(s).", len(by_relation)
        )

    def _upsert_chunk_mentions(self, triples: list[Triple]) -> None:
        """
        Create (:Chunk)-[:MENTIONS]->(:Concept) edges.
        Deduplicates so each (chunk, concept) pair gets one edge.
        """
        # Collect unique (chunk_id, concept_name, doc_id) pairs
        seen: set[tuple[str, str]] = set()
        mentions = []
        for t in triples:
            for name in (t.subject, t.object_):
                key = (t.chunk_id, name)
                if key not in seen:
                    seen.add(key)
                    mentions.append({
                        "chunk_id": t.chunk_id,
                        "concept": name,
                        "doc_id": t.doc_id,
                    })

        for start in range(0, len(mentions), _BATCH_SIZE):
            batch = mentions[start : start + _BATCH_SIZE]
            self._session.run(
                """
                UNWIND $mentions AS m
                MATCH (ch:Chunk {chunk_id: m.chunk_id})
                MATCH (c:Concept {name: m.concept, doc_id: m.doc_id})
                MERGE (ch)-[:MENTIONS]->(c)
                """,
                mentions=batch,
            )

        logger.debug("Upserted %d MENTIONS edge(s).", len(mentions))