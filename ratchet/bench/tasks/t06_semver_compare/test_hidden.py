import pytest

from solution import compare_versions


def test_equal_versions():
    assert compare_versions("1.2.3", "1.2.3") == 0
    assert compare_versions("0.0.0", "0.0.0") == 0


def test_major_minor_patch_order():
    assert compare_versions("1.2.3", "2.0.0") == -1
    assert compare_versions("1.2.3", "1.3.0") == -1
    assert compare_versions("1.2.3", "1.2.4") == -1
    assert compare_versions("2.0.0", "1.99.99") == 1


def test_numbers_compare_numerically_not_lexically():
    assert compare_versions("1.10.0", "1.9.0") == 1
    assert compare_versions("1.0.2", "1.0.10") == -1


def test_prerelease_is_lower_than_release():
    assert compare_versions("1.0.0-alpha", "1.0.0") == -1
    assert compare_versions("1.0.0", "1.0.0-rc.1") == 1


def test_numeric_prerelease_identifiers_compare_numerically():
    assert compare_versions("1.0.0-alpha.2", "1.0.0-alpha.10") == -1
    assert compare_versions("1.0.0-rc.11", "1.0.0-rc.9") == 1


def test_numeric_identifiers_lower_than_alphanumeric():
    assert compare_versions("1.0.0-alpha.1", "1.0.0-alpha.beta") == -1
    assert compare_versions("1.0.0-a", "1.0.0-1") == 1


def test_alphanumeric_identifiers_use_ascii_order():
    assert compare_versions("1.0.0-alpha", "1.0.0-beta") == -1
    assert compare_versions("1.0.0-Beta", "1.0.0-alpha") == -1
    assert compare_versions("1.0.0-rc-1", "1.0.0-rc") == 1


def test_more_identifiers_win_when_prefix_equal():
    assert compare_versions("1.0.0-alpha", "1.0.0-alpha.1") == -1
    assert compare_versions("1.0.0-alpha.1.0", "1.0.0-alpha.1") == 1


def test_semver_spec_precedence_chain():
    chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
             "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"]
    for lower, higher in zip(chain, chain[1:]):
        assert compare_versions(lower, higher) == -1
        assert compare_versions(higher, lower) == 1


def test_build_metadata_is_ignored():
    assert compare_versions("1.0.0+build.1", "1.0.0+build.2") == 0
    assert compare_versions("1.0.0-alpha+001", "1.0.0-alpha") == 0
    assert compare_versions("1.0.0+zzz", "1.0.1") == -1


def test_optional_v_prefix():
    assert compare_versions("v1.2.3", "1.2.3") == 0
    assert compare_versions("V2.0.0", "v1.9.9") == 1


def test_malformed_versions_raise():
    for bad in ["1.0", "1.0.0.0", "1.x.0", "", "a.b.c", "1.0.0-", "1.0.0+", "1.0.0-alpha..1", "1..0", "vv1.0.0"]:
        with pytest.raises(ValueError):
            compare_versions(bad, "1.0.0")
        with pytest.raises(ValueError):
            compare_versions("1.0.0", bad)


def test_leading_zeros_are_invalid():
    for bad in ["01.0.0", "1.02.0", "1.0.00", "1.0.0-alpha.01"]:
        with pytest.raises(ValueError):
            compare_versions(bad, "1.0.0")
    assert compare_versions("0.0.1", "0.0.0") == 1
    assert compare_versions("1.0.0-0", "1.0.0-00a") == -1
