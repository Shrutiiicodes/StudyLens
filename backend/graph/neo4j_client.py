"""
graph/neo4j_client.py
Single point of contact for the Neo4j driver.

Responsibilities
----------------
- Create and manage the Neo4j driver singleton.
- Ensure uniqueness constraints exist before any writes (idempotent).
- Expose a clean context manager for sessions.

Usage
-----
    from graph.neo4j_client import Neo4jClient

    client = Neo4jClient()          # reads env vars automatically
    client.verify_connectivity()    # raises if Neo4j is unreachable
    with client.session() as s:
        s.run("MATCH (n) RETURN count(n)")
    client.close()
"""

import logging
import os
from contextlib import contextmanager
from typing import Optional

from neo4j import GraphDatabase, Driver, Session

logger = logging.getLogger(__name__)


class Neo4jClient:
    """
    Thin wrapper around the Neo4j Python driver.

    Reads connection details from environment variables by default:
        NEO4J_URI       e.g. bolt://localhost:7687
        NEO4J_USER      e.g. neo4j
        NEO4J_PASSWORD  e.g. yourpassword

    Parameters override env vars when provided explicitly —
    useful for testing.
    """

    # Uniqueness constraints required by the graph schema.
    _CONSTRAINTS = [
        ("Document", "doc_id"),
        ("Chunk",    "chunk_id"),
    ]

    def __init__(
        self,
        uri: Optional[str] = None,
        user: Optional[str] = None,
        password: Optional[str] = None,
    ):
        self._uri      = uri      or os.environ["NEO4J_URI"]
        self._user     = user     or os.environ.get("NEO4J_USER", "neo4j")
        self._password = password or os.environ["NEO4J_PASSWORD"]
        self._driver: Optional[Driver] = None

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    def connect(self) -> "Neo4jClient":
        """
        Open the driver and ensure schema constraints exist.
        Safe to call multiple times — subsequent calls are no-ops.
        Returns self so it can be chained: client = Neo4jClient().connect()
        """
        if self._driver is None:
            logger.info("Connecting to Neo4j at %s ...", self._uri)
            self._driver = GraphDatabase.driver(
                self._uri, auth=(self._user, self._password)
            )
            self._create_constraints()
            logger.info("Neo4j connection established.")
        return self

    def verify_connectivity(self) -> None:
        """Ping Neo4j. Raises ServiceUnavailable if unreachable."""
        self._ensure_connected()
        self._driver.verify_connectivity()
        logger.info("Neo4j connectivity verified.")

    def close(self) -> None:
        """Close the driver and release all connections."""
        if self._driver:
            self._driver.close()
            self._driver = None
            logger.info("Neo4j driver closed.")

    # ------------------------------------------------------------------
    # Session access
    # ------------------------------------------------------------------

    @contextmanager
    def session(self, **kwargs):
        """
        Context manager yielding a Neo4j Session.

        Example:
            with client.session() as s:
                s.run("MATCH (n) RETURN n LIMIT 1")
        """
        self._ensure_connected()
        s: Session = self._driver.session(**kwargs)
        try:
            yield s
        finally:
            s.close()

    # ------------------------------------------------------------------
    # Schema setup
    # ------------------------------------------------------------------

    def _create_constraints(self) -> None:
        """
        Create uniqueness constraints for Document and Chunk nodes.
        IF NOT EXISTS makes this fully idempotent — safe to run on
        every startup.
        """
        with self.session() as session:
            for label, prop in self._CONSTRAINTS:
                name = f"unique_{label.lower()}_{prop}"
                session.run(
                    f"CREATE CONSTRAINT {name} IF NOT EXISTS "
                    f"FOR (n:{label}) REQUIRE n.{prop} IS UNIQUE"
                )
                logger.debug("Constraint ensured: %s.%s", label, prop)
        logger.info("Neo4j schema constraints verified.")

    def _ensure_connected(self) -> None:
        if self._driver is None:
            self.connect()

    # ------------------------------------------------------------------
    # Context manager support
    # ------------------------------------------------------------------

    def __enter__(self) -> "Neo4jClient":
        return self.connect()

    def __exit__(self, *_) -> None:
        self.close()