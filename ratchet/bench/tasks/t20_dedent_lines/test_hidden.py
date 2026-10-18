from solution import dedent


def test_common_indentation_removed():
    assert dedent("    a\n    b") == "a\nb"


def test_relative_indentation_is_kept():
    assert dedent("  a\n    b\n  c") == "a\n  b\nc"


def test_no_common_indentation_leaves_text_unchanged():
    assert dedent("a\n  b") == "a\n  b"
    assert dedent("no indent at all") == "no indent at all"


def test_blank_lines_do_not_affect_prefix():
    assert dedent("    a\n\n    b") == "a\n\nb"


def test_whitespace_only_lines_become_empty():
    assert dedent("    a\n  \n    b") == "a\n\nb"
    assert dedent("  a\n        \n  b") == "a\n\nb"
    assert dedent("  a\n\t\n  b") == "a\n\nb"


def test_tabs_and_spaces_are_not_equivalent():
    assert dedent("\ta\n    b") == "\ta\n    b"
    assert dedent("    a\n\tb") == "    a\n\tb"


def test_common_tab_prefix_is_removed():
    assert dedent("\t\ta\n\tb") == "\ta\nb"


def test_prefix_is_compared_character_by_character():
    assert dedent("\t    a\n\t  b") == "  a\nb"
    assert dedent("  \ta\n   b") == "\ta\n b"


def test_single_leading_newline_is_removed():
    assert dedent("\n    a\n    b") == "a\nb"
    assert dedent("\n\n  a") == "\na"


def test_trailing_newline_is_preserved():
    assert dedent("  a\n  b\n") == "a\nb\n"
    assert dedent("\n    x = 1\n\n    y = 2\n") == "x = 1\n\ny = 2\n"


def test_trailing_whitespace_on_lines_is_kept():
    assert dedent("  a  \n  b\t") == "a  \nb\t"


def test_empty_and_whitespace_only_text():
    assert dedent("") == ""
    assert dedent("   \n  ") == "\n"


def test_single_line():
    assert dedent("    x") == "x"
    assert dedent("\tx") == "x"
