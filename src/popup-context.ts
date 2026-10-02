import { parseInput } from "./instagram";
import type { Input } from "./types";
export function instagramTabInput(value?: string): Input | undefined {
  try {
    const url = new URL(value || "");
    if (url.origin !== "https://www.instagram.com") return;
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      parts.length === 2 &&
      ["followers", "following", "reels"].includes(parts[1]) &&
      !["p", "reel", "reels"].includes(parts[0])
    )
      url.pathname = `/${parts[0]}/`;
    return parseInput(url.href);
  } catch {
    return;
  }
}
export function sameInput(a: Input, b: Input) {
  return a.type === "profile" && b.type === "profile"
    ? a.username === b.username
    : a.type === "post" && b.type === "post" && a.shortcode === b.shortcode;
}
