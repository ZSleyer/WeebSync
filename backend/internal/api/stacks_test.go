package api

import "testing"

func TestStacksTreatsSplitEpisodeAsOneCopy(t *testing.T) {
	f := func(names ...string) []DuplicateFile {
		out := make([]DuplicateFile, len(names))
		for i, n := range names {
			out[i] = DuplicateFile{Path: "/lib/Show/Season 01/" + n}
		}
		return out
	}
	if n := stacks(f("Detektiv_Conan_-_S01E11_(11).mp4", "Detektiv_Conan_-_S01E11_(11).pt2.mp4")); n != 1 {
		t.Errorf("pt2 continues pt1: %d stacks, want 1", n)
	}
	if n := stacks(f("Show - S01E03 - cd1.mkv", "Show - S01E03 - cd2.mkv", "Show - S01E03 part3.mkv")); n != 1 {
		t.Errorf("cd/part markers: %d stacks, want 1", n)
	}
	if n := stacks(f("Show - S01E11.mkv", "Show - S01E11 [v2].mkv")); n != 2 {
		t.Errorf("two releases: %d stacks, want 2", n)
	}
	if n := stacks(f("Show - S01E11.mp4", "Show - S01E11.pt2.mp4", "Show - S01E11 [BD].mkv")); n != 2 {
		t.Errorf("a stack beside another release: %d stacks, want 2", n)
	}
}
