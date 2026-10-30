"""Languages and reading levels shared by every module."""
from typing import Literal

Language = Literal["en", "hi", "te"]
Level = Literal["letter", "word", "sentence", "paragraph"]
LEVELS: tuple[str, ...] = ("letter", "word", "sentence", "paragraph")
LANGUAGE_NAMES = {"en": "English", "hi": "Hindi", "te": "Telugu"}
