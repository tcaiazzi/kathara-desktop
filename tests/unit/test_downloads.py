"""Unit tests for the ``Content-Disposition`` builder (no Docker required).

The filename is derived from user-controlled input — a lab name, or the basename of an arbitrary
``?path=`` — so it can contain characters the quoted header form cannot represent.
"""

from kathara_api.downloads import attachment_headers


def _disposition(filename: str) -> str:
    return attachment_headers(filename)["Content-Disposition"]


def test_plain_name_is_emitted_in_both_forms():
    assert _disposition("notes.txt") == "attachment; filename=\"notes.txt\"; filename*=UTF-8''notes.txt"


def test_quote_cannot_break_out_of_the_quoted_form():
    # A bare `"` would end the quoted string early and let the rest of the name be read as further
    # header parameters; the real name still travels intact in the `filename*` form.
    value = _disposition('ev"il.txt')
    assert 'filename="ev_il.txt"' in value
    assert value.endswith("filename*=UTF-8''ev%22il.txt")


def test_backslash_and_control_characters_are_neutralized():
    value = _disposition("a\\b\nc")
    assert 'filename="a_b_c"' in value


def test_non_ascii_name_survives_in_the_extended_form():
    value = _disposition("àccénti.txt")
    assert 'filename="_cc_nti.txt"' in value
    assert value.endswith("filename*=UTF-8''%C3%A0cc%C3%A9nti.txt")


def test_empty_name_falls_back_in_both_forms():
    assert _disposition("") == "attachment; filename=\"download\"; filename*=UTF-8''download"
