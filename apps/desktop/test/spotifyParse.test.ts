import { describe, it, expect } from "bun:test";
import { parseSpotifyOutput } from "../src/main/spotifyParse";

describe("parseSpotifyOutput", () => {
  it("parses a playing track and derives the open URL", () => {
    const raw = "playing\tspotify:track:4U4YIDoopcrqZq8CCzdgjd\tYonaguni\tGreg Foat";
    expect(parseSpotifyOutput(raw)).toEqual({
      trackId: "4U4YIDoopcrqZq8CCzdgjd",
      name: "Yonaguni",
      artist: "Greg Foat",
      url: "https://open.spotify.com/track/4U4YIDoopcrqZq8CCzdgjd",
      isPlaying: true,
    });
  });

  it("returns null when Spotify is paused — V1 only broadcasts actively playing", () => {
    const raw = "paused\tspotify:track:123\tTitle\tArtist";
    expect(parseSpotifyOutput(raw)).toBeNull();
  });

  it.each([
    ["empty string", ""],
    ["whitespace", "   "],
    ["not-running sentinel", "not-running"],
    ["stopped sentinel", "stopped"],
    ["error sentinel", "error"],
  ])("returns null for %s", (_label, raw) => {
    expect(parseSpotifyOutput(raw.trim())).toBeNull();
  });

  it("returns null when the URI doesn't match the spotify:track: shape", () => {
    const raw = "playing\tspotify:episode:xyz\tTitle\tArtist";
    expect(parseSpotifyOutput(raw)).toBeNull();
  });

  it("returns null when fewer than 4 tab-separated fields arrive", () => {
    expect(parseSpotifyOutput("playing\tspotify:track:abc\tTitle")).toBeNull();
  });

  it("returns null when any core field is empty", () => {
    expect(
      parseSpotifyOutput("playing\tspotify:track:abc\t\tArtist"),
    ).toBeNull();
    expect(
      parseSpotifyOutput("playing\tspotify:track:abc\tTitle\t"),
    ).toBeNull();
  });

  it("preserves punctuation and unicode in name/artist (no re-encoding)", () => {
    const raw =
      "playing\tspotify:track:abc\tWhat's Up? (Remastered) — 2021\tDJ “Kōji” Ōshō";
    const got = parseSpotifyOutput(raw);
    expect(got?.name).toBe("What's Up? (Remastered) — 2021");
    expect(got?.artist).toBe('DJ “Kōji” Ōshō');
  });
});
