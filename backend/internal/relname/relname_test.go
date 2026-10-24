package relname

import (
	"reflect"
	"testing"
)

func TestRead(t *testing.T) {
	cases := []struct {
		name string
		want Release
	}{
		// fansub style: leading group, " - " episode, tag block
		{"[SubCrew] Moon Garden - 01 [1080p][ABCD1234].mkv",
			Release{Title: "Moon Garden", Episodes: []string{"01"}, Group: "SubCrew", Resolution: "1080p", Ext: "mkv"}},
		// scene style: dotted words, SxxEyy, trailing -GROUP
		{"Moon.Garden.S02E05.German.DL.1080p.WEB.x264-NOGRP.mkv",
			Release{Title: "Moon Garden", Season: 2, HasSeason: true, Episodes: []string{"05"}, Group: "NOGRP", Resolution: "1080p", Ext: "mkv"}},
		// German streaming style; a language tag is never the group
		{"Moon Garden E07 [1080p][AAC][JapDub][GerSub][Web-DL].mkv",
			Release{Title: "Moon Garden", Episodes: []string{"07"}, Resolution: "1080p", Ext: "mkv"}},
		{"Moon Garden - 2. Staffel E15 [720p][GerDub].mkv",
			Release{Title: "Moon Garden", Season: 2, HasSeason: true, Episodes: []string{"15"}, Resolution: "720p", Ext: "mkv"}},
		{"Moon Garden Staffel 3 Folge 4.mkv",
			Release{Title: "Moon Garden", Season: 3, HasSeason: true, Episodes: []string{"4"}, Ext: "mkv"}},
		{"Moon Garden Second Season E02.mkv",
			Release{Title: "Moon Garden", Season: 2, HasSeason: true, Episodes: []string{"02"}, Ext: "mkv"}},
		// season 0 is the specials season, not "no season"
		{"Moon Garden - S00E04 [1080p].mkv",
			Release{Title: "Moon Garden", HasSeason: true, Episodes: []string{"04"}, Resolution: "1080p", Ext: "mkv"}},
		// SxxEyy glued to the episode title by a dash
		{"S01E04-The.Long.Night.(WEBDL-1080p).(x264).(AC3 5.1)-(NOGRP).mkv",
			Release{Season: 1, HasSeason: true, Episodes: []string{"04"}, Group: "NOGRP", Resolution: "1080p", Ext: "mkv"}},
		// an arc's episode range in parens is not the episode
		{"Long Runner - Arc Name (385-516) E497 [1080p][GerSub].mkv",
			Release{Title: "Long Runner - Arc Name", Episodes: []string{"497"}, Resolution: "1080p", Ext: "mkv"}},
		// fractional specials, with a dot or a comma
		{"Long Runner E1165.5 [1080p].mkv",
			Release{Title: "Long Runner", Episodes: []string{"1165.5"}, Resolution: "1080p", Ext: "mkv"}},
		{"Moon Garden E10,5 [1080p].mkv",
			Release{Title: "Moon Garden", Episodes: []string{"10.5"}, Resolution: "1080p", Ext: "mkv"}},
		{"[SubCrew] Moon Garden S1 - 22,5 [BD 1080p].mkv",
			Release{Title: "Moon Garden", Season: 1, HasSeason: true, Episodes: []string{"22.5"}, Group: "SubCrew", Resolution: "1080p", Ext: "mkv"}},
		{"Moon Garden E14.5P1 [1080p].mkv",
			Release{Title: "Moon Garden", Episodes: []string{"14.5"}, Resolution: "1080p", Ext: "mkv"}},
		{"Moon.Garden.S01Ep11.5.GerSub.1080p.WebRip.x264-NOGRP.mkv",
			Release{Title: "Moon Garden", Season: 1, HasSeason: true, Episodes: []string{"11.5"}, Group: "NOGRP", Resolution: "1080p", Ext: "mkv"}},
		{"[SubCrew] Moon Garden - 07v0.5 [DVD 576p].mkv",
			Release{Title: "Moon Garden", Episodes: []string{"07"}, Group: "SubCrew", Resolution: "576p", Ext: "mkv"}},
		{"[SubCrew] Moon Garden - OVA (10.5) [BD 1080p].mkv",
			Release{Title: "Moon Garden - OVA", Episodes: []string{"10.5"}, Kinds: []string{"OVA"}, Group: "SubCrew", Resolution: "1080p", Ext: "mkv"}},
		{"Long Runner E500.5 [1080p].mkv",
			Release{Title: "Long Runner", Episodes: []string{"500.5"}, Resolution: "1080p", Ext: "mkv"}},
		// a kind with its number
		{"Moon Garden OVA 01 [720p].mkv",
			Release{Title: "Moon Garden OVA", Episodes: []string{"01"}, Kinds: []string{"OVA"}, Resolution: "720p", Ext: "mkv"}},
		{"[SubCrew] Moon Garden - NCED1 [BD][ABCD1234].mkv",
			Release{Title: "Moon Garden", Episodes: []string{"1"}, Kinds: []string{"NCED"}, Group: "SubCrew", Ext: "mkv"}},
		// a film's number is no episode
		{"Moon Garden Movie 06 [1080p].mkv",
			Release{Title: "Moon Garden Movie 06", Kinds: []string{"Movie"}, Resolution: "1080p", Ext: "mkv"}},
		// a kind word inside a title is just a word
		{"Funny TV Hour E09 [1080p].mkv",
			Release{Title: "Funny TV Hour", Episodes: []string{"09"}, Resolution: "1080p", Ext: "mkv"}},
		// a year with an episode marker after it belongs to the title
		{"[SubCrew] Star Hunter 2011 - 138 [720p].mkv",
			Release{Title: "Star Hunter 2011", Episodes: []string{"138"}, Group: "SubCrew", Resolution: "720p", Ext: "mkv"}},
		// folder names: year, alternative title, tags; the sequel number stays
		{"Moon Garden 2 (2016)",
			Release{Title: "Moon Garden 2", Year: 2016}},
		{"Moon Garden (Garden of the Moon) [GerJapDub,GerSub,BD]",
			Release{Title: "Moon Garden"}},
		{"Moon Garden 2199 [JapDub,GerSub]",
			Release{Title: "Moon Garden 2199"}},
		// audio channels and codecs are never the episode or the group
		{"Moon.Garden.01.German.DTS.5.1.DL.1080p.BluRay.x264-NOGRP.mkv",
			Release{Title: "Moon Garden", Episodes: []string{"01"}, Group: "NOGRP", Resolution: "1080p", Ext: "mkv"}},
		{"Moon.Garden.(2019).(Bluray-1080p).(x265).(AC3.5.1)-(NOGRP).mkv",
			Release{Title: "Moon Garden", Year: 2019, Group: "NOGRP", Resolution: "1080p", Ext: "mkv"}},
		// a bare bracketed number is the weakest episode guess
		{"[SubCrew][BDRIP][04][X264_AAC][720P].mkv",
			Release{Episodes: []string{"04"}, Group: "SubCrew", Resolution: "720P", Ext: "mkv"}},
		// a frame size counts as resolution
		{"Moon Garden - 03 [Blu-ray][HEVC 1440x1080p][AAC].mkv",
			Release{Title: "Moon Garden", Episodes: []string{"03"}, Resolution: "1440x1080", Ext: "mkv"}},
		// a title ending in "Episodes" keeps it; the episode is the bare number
		{"Moon Garden Mini Episodes E01 [1080p].mkv",
			Release{Title: "Moon Garden Mini Episodes", Episodes: []string{"01"}, Resolution: "1080p", Ext: "mkv"}},
		// two episodes in one file
		{"Moon Garden - S01E17+S01E18 (BD 1080p).mkv",
			Release{Title: "Moon Garden", Season: 1, HasSeason: true, Episodes: []string{"17"}, Resolution: "1080p", Ext: "mkv"}},
		{"Moon Garden - 01-02 [720p].mkv",
			Release{Title: "Moon Garden", Episodes: []string{"01", "02"}, Resolution: "720p", Ext: "mkv"}},
	}
	for _, c := range cases {
		if got := Read(c.name); !reflect.DeepEqual(got, c.want) {
			t.Errorf("Read(%q)\n got  %+v\n want %+v", c.name, got, c.want)
		}
	}
}

// Names come off remote servers; whatever they hold, Read must not panic.
func FuzzRead(f *testing.F) {
	for _, s := range []string{"[A] B - 01 [1080p].mkv", "A.S01E01-B.(x).-(C).mkv", "((([[[", "- - 1-2 S1 E", "A 2. Staffel E1,5.mp4", "A - 05.ger.forced.srt", ".en.srt", "a.ass"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) { Read(s) })
}

func TestIsSmallNumNoSign(t *testing.T) {
	for s, want := range map[string]bool{"5": true, "99": true, "+5": false, "-5": false, "100": false, "0": false, "": false, "x": false} {
		if got := isSmallNum(s); got != want {
			t.Errorf("isSmallNum(%q) = %v, want %v", s, got, want)
		}
	}
}
