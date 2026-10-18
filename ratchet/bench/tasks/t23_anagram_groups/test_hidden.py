from solution import group_anagrams


def test_basic_groups_in_first_appearance_order():
    words = ["eat", "tea", "tan", "ate", "nat", "bat"]
    assert group_anagrams(words) == [["eat", "tea", "ate"], ["tan", "nat"], ["bat"]]


def test_groups_are_not_sorted():
    assert group_anagrams(["zyx", "abc", "xyz", "cab"]) == [["zyx", "xyz"], ["abc", "cab"]]


def test_case_insensitive_and_originals_kept():
    assert group_anagrams(["Listen", "Silent", "enlist"]) == [["Listen", "Silent", "enlist"]]
    assert group_anagrams(["AbC", "cba"]) == [["AbC", "cba"]]


def test_spaces_are_ignored_but_kept_in_output():
    assert group_anagrams(["dormitory", "dirty room"]) == [["dormitory", "dirty room"]]
    assert group_anagrams(["a b", "ba"]) == [["a b", "ba"]]


def test_punctuation_and_other_whitespace_count():
    assert group_anagrams(["dirty room!", "dormitory"]) == [["dirty room!"], ["dormitory"]]
    assert group_anagrams(["a\tb", "ab"]) == [["a\tb"], ["ab"]]


def test_duplicates_are_kept():
    assert group_anagrams(["abc", "cab", "abc"]) == [["abc", "cab", "abc"]]


def test_empty_input():
    assert group_anagrams([]) == []


def test_empty_and_space_only_strings_group_together():
    assert group_anagrams(["", " ", "a", "  "]) == [["", " ", "  "], ["a"]]


def test_letter_multiplicity_matters():
    assert group_anagrams(["aab", "abb", "aba"]) == [["aab", "aba"], ["abb"]]
    assert group_anagrams(["ab", "aab"]) == [["ab"], ["aab"]]


def test_all_singletons():
    assert group_anagrams(["one", "two", "three"]) == [["one"], ["two"], ["three"]]


def test_input_not_modified():
    words = ["b", "a", "B"]
    group_anagrams(words)
    assert words == ["b", "a", "B"]
