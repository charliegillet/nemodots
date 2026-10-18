from solution import parse_query


def test_simple_pairs():
    assert parse_query("a=1&b=2") == {"a": "1", "b": "2"}


def test_leading_question_mark_is_ignored():
    assert parse_query("?a=1") == {"a": "1"}
    assert parse_query("?") == {}


def test_repeated_keys_become_lists_in_order():
    assert parse_query("a=1&b=x&a=2&a=3") == {"a": ["1", "2", "3"], "b": "x"}


def test_repeated_identical_values_are_all_kept():
    assert parse_query("a=1&a=1") == {"a": ["1", "1"]}
    assert parse_query("a=1&a=2&a=1") == {"a": ["1", "2", "1"]}


def test_single_occurrence_stays_a_string():
    result = parse_query("a=1&b=2&b=3")
    assert result["a"] == "1"
    assert isinstance(result["a"], str)


def test_plus_means_space_in_keys_and_values():
    assert parse_query("q=hello+world") == {"q": "hello world"}
    assert parse_query("first+name=Ada") == {"first name": "Ada"}


def test_percent_decoding_including_utf8():
    assert parse_query("q=a%20b") == {"q": "a b"}
    assert parse_query("city=caf%C3%A9&k%C3%A9y=1") == {"city": "café", "kéy": "1"}


def test_encoded_plus_is_a_literal_plus():
    assert parse_query("expr=1%2B1") == {"expr": "1+1"}


def test_encoded_delimiters_are_literal_after_split():
    assert parse_query("a=1%262&b=x%3Dy") == {"a": "1&2", "b": "x=y"}


def test_key_without_equals_has_empty_value():
    assert parse_query("flag&x=1") == {"flag": "", "x": "1"}
    assert parse_query("a=") == {"a": ""}


def test_value_may_contain_equals():
    assert parse_query("a=b=c") == {"a": "b=c"}


def test_empty_segments_are_skipped():
    assert parse_query("a=1&&b=2&") == {"a": "1", "b": "2"}
    assert parse_query("") == {}
    assert parse_query("&&") == {}


def test_invalid_percent_escapes_are_kept():
    assert parse_query("a=100%") == {"a": "100%"}
    assert parse_query("a=%zz&b=%4") == {"a": "%zz", "b": "%4"}


def test_repeated_key_with_missing_value():
    assert parse_query("a&a=1") == {"a": ["", "1"]}


def test_keys_keep_first_appearance_order():
    assert list(parse_query("z=1&a=2&z=3&m=4")) == ["z", "a", "m"]
