"""Languages and reading levels shared by every module."""
from typing import Literal

Language = Literal["en", "hi", "te"]
# ASER ladders: paragraph = Std 1 text, story = Std 2 text. In English, "capital" is capital letters
# and "letter" small letters; English stops at simple sentences, as in ASER's English tool.
Level = Literal["capital", "letter", "word", "sentence", "paragraph", "story"]
LEVELS: tuple[str, ...] = ("capital", "letter", "word", "sentence", "paragraph", "story")
LADDERS: dict[str, tuple[str, ...]] = {
    "hi": ("letter", "word", "sentence", "paragraph", "story"),
    "te": ("letter", "word", "sentence", "paragraph", "story"),
    "en": ("capital", "letter", "word", "sentence"),
}
LANGUAGE_NAMES = {"en": "English", "hi": "Hindi", "te": "Telugu"}
