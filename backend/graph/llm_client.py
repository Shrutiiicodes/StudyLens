import os
from typing import Optional


class GroqLLMClient:
    """Minimal Groq-backed client for TripleVerifier."""

    def __init__(
        self,
        model: str = "llama-3.3-70b-versatile",
        api_key: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: int = 512,
    ) -> None:
        try:
            from groq import Groq
        except ImportError as exc:
            raise ImportError("groq package not installed. Run: pip install groq") from exc

        key = api_key or os.environ["GROQ_API_KEY"]
        self._client = Groq(api_key=key)
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens

    def generate(self, prompt: str) -> str:
        response = self._client.chat.completions.create(
            model=self.model,
            messages=[
                {
                    "role": "system",
                    "content": "Return strict JSON only. Do not add markdown or explanations.",
                },
                {"role": "user", "content": prompt},
            ],
            temperature=self.temperature,
            max_tokens=self.max_tokens,
        )
        return response.choices[0].message.content or ""


class DummyLLMClient:
    def generate(self, prompt: str) -> str:
        return """
        {
          "is_supported": true,
          "confidence": 0.92,
          "reason": "The passage clearly supports the triple.",
          "corrected_subject": null,
          "corrected_predicate": null,
          "corrected_object": null
        }
        """.strip()
