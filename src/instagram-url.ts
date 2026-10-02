import type { Input } from "./types";

// Instagram opens the same media at /p/code/ and /username/p/code/.
// Keep stored inputs canonical, but compare pages by their media shortcode.
export function postFromPath(
  pathname: string,
): Extract<Input, { type: "post" }> | undefined {
  const parts = pathname.split("/").filter(Boolean);
  const kinds = ["p", "reel", "reels", "tv"];
  const offset = kinds.includes(parts[0]) ? 0 : 1;
  if (
    offset &&
    (!/^[a-zA-Z0-9_.]{1,30}$/.test(parts[0] || "") ||
      [
        "accounts",
        "explore",
        "direct",
        "stories",
        "challenge",
        "checkpoint",
      ].includes(parts[0].toLowerCase()))
  )
    return;
  if (
    !kinds.includes(parts[offset]) ||
    !/^[A-Za-z0-9_-]+$/.test(parts[offset + 1] || "")
  )
    return;
  const shortcode = parts[offset + 1];
  return {
    type: "post",
    shortcode,
    url: `https://www.instagram.com/${parts[offset] === "p" ? "p" : "reel"}/${shortcode}/`,
  };
}

export function samePostPath(a: string, b: string): boolean {
  const first = postFromPath(a),
    second = postFromPath(b);
  return !!first && !!second && first.shortcode === second.shortcode;
}
