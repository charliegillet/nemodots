from solution import is_balanced


def test_simple_balanced():
    assert is_balanced("()[]{}")
    assert is_balanced("f(a[0], {b: c})")


def test_nested_balanced():
    assert is_balanced("{[()()]}")
    assert is_balanced("((([[[{{{}}}]]])))")


def test_wrong_order_or_type():
    assert not is_balanced("(]")
    assert not is_balanced("([)]")
    assert not is_balanced("{(})")


def test_unclosed_opening():
    assert not is_balanced("((")
    assert not is_balanced("[")
    assert not is_balanced("f(x")


def test_closing_without_opening():
    assert not is_balanced("())")
    assert not is_balanced(")(")
    assert not is_balanced("]")


def test_brackets_in_double_quoted_strings_are_ignored():
    assert is_balanced('print(")")')
    assert is_balanced('x = "(" + "]"')


def test_brackets_in_single_quoted_strings_are_ignored():
    assert is_balanced("f(')')")
    assert is_balanced("s = '[' + '{'")


def test_escaped_quote_does_not_end_string():
    assert is_balanced(r'f("a\")(")')
    assert is_balanced(r"f('it\'s (')")
    assert not is_balanced(r'("\")')


def test_escaped_backslash_then_quote_ends_string():
    assert not is_balanced(r'"\\"(')
    assert is_balanced(r'f("\\")')
    assert is_balanced(r'f("\\\"(")')


def test_other_quote_kind_inside_string():
    assert is_balanced('''f("it's")''')
    assert is_balanced("""f('say "hi')""")


def test_unterminated_string_is_unbalanced():
    assert not is_balanced('f("abc)')
    assert not is_balanced("'")
    assert not is_balanced('"abc\\"')


def test_empty_and_bracket_free_input():
    assert is_balanced("")
    assert is_balanced("hello world")


def test_backslash_outside_string_is_ordinary():
    assert is_balanced(r"(\)")
    assert is_balanced(r"a = b \ (c)")
