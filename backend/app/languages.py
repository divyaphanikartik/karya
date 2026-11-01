"""Languages and reading levels shared by every module."""
from typing import Literal

Language = Literal["en", "hi", "te"]
MAX_GRADE = 3  # the app covers Grades 1-3 (the foundational stage)
# ASER ladders: paragraph = Std 1 text, story = Std 2 text; Hindi/Telugu have no sentence level. In English, "capital" is capital letters
# and "letter" small letters; English stops at simple sentences, as in ASER's English tool.
Level = Literal["capital", "letter", "word", "sentence", "paragraph", "story"]
LEVELS: tuple[str, ...] = ("capital", "letter", "word", "sentence", "paragraph", "story")
LADDERS: dict[str, tuple[str, ...]] = {
    "hi": ("letter", "word", "paragraph", "story"),
    "te": ("letter", "word", "paragraph", "story"),
    "en": ("capital", "letter", "word", "sentence"),
}
LANGUAGE_NAMES = {"en": "English", "hi": "Hindi", "te": "Telugu"}
