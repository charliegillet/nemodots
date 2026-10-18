from solution import to_camel, to_snake


def test_snake_from_camel():
    assert to_snake("fooBar") == "foo_bar"
    assert to_snake("fooBarBaz") == "foo_bar_baz"


def test_snake_from_pascal():
    assert to_snake("FooBar") == "foo_bar"
    assert to_snake("Foo") == "foo"


def test_snake_splits_acronym_before_word():
    assert to_snake("HTTPServer") == "http_server"
    assert to_snake("getHTTPResponseCode") == "get_http_response_code"
    assert to_snake("XMLHttpRequest") == "xml_http_request"


def test_snake_acronym_at_end_or_alone():
    assert to_snake("parseURL") == "parse_url"
    assert to_snake("ABC") == "abc"
    assert to_snake("userID") == "user_id"


def test_snake_digits_stick_to_preceding_letters():
    assert to_snake("v2Beta") == "v2_beta"
    assert to_snake("utf8Decode") == "utf8_decode"
    assert to_snake("base64") == "base64"
    assert to_snake("sha256Sum") == "sha256_sum"


def test_snake_already_snake_is_unchanged():
    for name in ["already_snake_case", "x", "a_b_c", "with_digits_2", "_private", "dunder__"]:
        assert to_snake(name) == name


def test_snake_existing_underscore_not_doubled():
    assert to_snake("foo_Bar") == "foo_bar"
    assert to_snake("HTTP_Server") == "http_server"


def test_snake_empty():
    assert to_snake("") == ""


def test_camel_basic():
    assert to_camel("foo_bar_baz") == "fooBarBaz"
    assert to_camel("foo") == "foo"


def test_camel_upper_first():
    assert to_camel("foo_bar", upper_first=True) == "FooBar"
    assert to_camel("x", upper_first=True) == "X"


def test_camel_ignores_extra_underscores():
    assert to_camel("__foo__bar_") == "fooBar"
    assert to_camel("_private_name") == "privateName"


def test_camel_lowercases_the_rest_of_each_part():
    assert to_camel("HTTP_SERVER") == "httpServer"
    assert to_camel("Foo_BAR") == "fooBar"
    assert to_camel("HTTP_SERVER", upper_first=True) == "HttpServer"


def test_camel_keeps_digits():
    assert to_camel("v2_beta") == "v2Beta"
    assert to_camel("sha256_sum") == "sha256Sum"


def test_camel_empty_or_only_underscores():
    assert to_camel("") == ""
    assert to_camel("___") == ""
