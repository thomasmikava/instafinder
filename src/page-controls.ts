// Instagram's reel action bar exposes the likes count as a bare number beside
// the heart control. Match that relationship, never the heart or a comment count.
export function numericLikesControl(controls: HTMLElement[]) {
  const numbers = new Set(
    controls.filter(
      (control) =>
        !control.querySelector("svg") &&
        /^[\p{N}][\p{N}.,\s]*(?:[kmb])?$/iu.test(
          control.textContent?.trim() || "",
        ),
    ),
  );
  for (const control of controls) {
    const heart = control.querySelector(
      'svg[aria-label="Like"],svg[aria-label="Unlike"]',
    );
    if (!heart) continue;
    let node: Element | null = heart.closest(
      'button,[role="button"],[role="link"],a[href]',
    );
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const parent: Element | null = node.parentElement;
      if (
        !parent ||
        parent === document.body ||
        parent === document.documentElement
      )
        break;
      const sibling = node.nextElementSibling;
      const candidate =
        sibling &&
        [
          sibling,
          ...sibling.querySelectorAll<HTMLElement>(
            'button,[role="button"],[role="link"],a[href]',
          ),
        ].find((element) => numbers.has(element as HTMLElement));
      if (
        candidate &&
        parent.querySelector(
          'svg[aria-label="Comment"],svg[aria-label="Share"],svg[aria-label="Repost"]',
        )
      )
        return candidate as HTMLElement;
      if (parent.matches('article,[role="dialog"]')) break;
    }
  }
}

export function commentLoadControl(controls: HTMLElement[]) {
  return controls.find((control) => {
    const label = [
      control.getAttribute("aria-label"),
      control.textContent,
      ...[...control.querySelectorAll("svg")].map((svg) =>
        svg.getAttribute("aria-label"),
      ),
    ];
    return label.some(
      (text) =>
        text &&
        /^(?:view|load|show|see|more)(?:\s+[\s\S]*?)?(?:comments?|repl(?:y|ies))(?:\s*\(\d+\))?$/i.test(
          text.trim(),
        ),
    );
  });
}

export function commentScrollTarget(root: HTMLElement) {
  const visible = (el: HTMLElement) => {
    const style = getComputedStyle(el);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      !!el.getClientRects().length
    );
  };
  const candidates = [
    root,
    ...root.querySelectorAll<HTMLElement>("div,ul,ol,section,[role=list]"),
  ].filter(
    (el) =>
      el !== document.scrollingElement &&
      visible(el) &&
      el.scrollHeight > el.clientHeight + 1 &&
      /auto|scroll/.test(getComputedStyle(el).overflowY),
  );
  const score = (el: HTMLElement) => {
    const timestamps = el.querySelectorAll('time,a[href*="/c/"]').length;
    const lists =
      el.matches("ul,ol,[role=list]") ||
      !!el.querySelector("ul,ol,[role=list]");
    const commentLabel =
      /comments?|replies/i.test(el.getAttribute("aria-label") || "") ||
      /^\s*comments\s*$/i.test(el.textContent || "");
    const authorLinks = [
      ...el.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ].filter((a) => {
      try {
        const url = new URL(a.href);
        return (
          url.origin === location.origin &&
          /^\/[a-zA-Z0-9_.]{1,30}\/$/.test(url.pathname)
        );
      } catch {
        return false;
      }
    }).length;
    return (
      timestamps * 10 +
      (commentLabel ? 20 : 0) +
      (lists ? 5 : 0) +
      Math.min(authorLinks, 5)
    );
  };
  const ranked = candidates
    .map((el) => ({ el, score: score(el) }))
    .sort((a, b) => b.score - a.score || a.el.scrollHeight - b.el.scrollHeight);
  if (ranked[0]?.score > 0) return ranked[0].el;
}
