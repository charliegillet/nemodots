import pytest

from solution import split_csv_line


def test_simple_fields():
    assert split_csv_line("a,b,c") == ["a", "b", "c"]


def test_quoted_field_keeps_delimiter():
    assert split_csv_line('"a,b",c') == ["a,b", "c"]
    assert split_csv_line('x,"1,2,3"') == ["x", "1,2,3"]


def test_doubled_quotes_become_one_quote():
    assert split_csv_line('"say ""hi""",x') == ['say "hi"', "x"]
    assert split_csv_line('""""') == ['"']


def test_trailing_delimiter_gives_trailing_empty_field():
    assert split_csv_line("a,b,") == ["a", "b", ""]
    assert split_csv_line('"a",') == ["a", ""]


def test_empty_line_is_one_empty_field():
    assert split_csv_line("") == [""]


def test_consecutive_delimiters_give_empty_fields():
    assert split_csv_line("a,,b") == ["a", "", "b"]
    assert split_csv_line(",") == ["", ""]
    assert split_csv_line(",,") == ["", "", ""]


def test_whitespace_is_preserved():
    assert split_csv_line(" a , b ") == [" a ", " b "]


def test_custom_delimiters():
    assert split_csv_line('a;b;"c;d"', delimiter=";") == ["a", "b", "c;d"]
    assert split_csv_line("a\tb,c", delimiter="\t") == ["a", "b,c"]


def test_empty_quoted_field():
    assert split_csv_line('"",x') == ["", "x"]
    assert split_csv_line('""') == [""]


def test_quote_not_at_field_start_is_literal():
    assert split_csv_line('ab"c,d') == ['ab"c', "d"]
    assert split_csv_line(' "x",y') == [' "x"', "y"]


def test_newline_inside_quotes_is_kept():
    assert split_csv_line('"a\nb",c') == ["a\nb", "c"]


def test_unterminated_quote_raises():
    for line in ['"abc,d', 'a,"b', '"a""']:
        with pytest.raises(ValueError):
            split_csv_line(line)


def test_text_after_closing_quote_raises():
    for line in ['"a"b,c', 'x,"a" ,y', '"a"b', 'x,"y"z', '"a" ']:
        with pytest.raises(ValueError):
            split_csv_line(line)


def test_invalid_delimiter_raises():
    for delimiter in ["", ";;", '"']:
        with pytest.raises(ValueError):
            split_csv_line("a,b", delimiter=delimiter)
