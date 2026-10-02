// Load Instagram CDN photos in the extension world, rather than embedding a
// cross-site no-CORS image. Never attach Instagram authentication credentials.
export function isInstagramPhoto(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      ["cdninstagram.com", "fbcdn.net"].some(
        (domain) =>
          url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    );
  } catch {
    return false;
  }
}
interface Photo {
  refs: number;
  controller: AbortController;
  ready: Promise<string>;
  objectUrl?: string;
}
const photos = new Map<string, Photo>();
export function acquireAvatar(url: string) {
  if (!isInstagramPhoto(url))
    return { ready: Promise.resolve(url), release: () => {} };
  let photo = photos.get(url);
  if (!photo) {
    const controller = new AbortController();
    const entry: Photo = { refs: 0, controller, ready: Promise.resolve("") };
    const timeout = setTimeout(() => controller.abort(), 15000);
    entry.ready = fetch(url, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Photo unavailable.");
        const blob = await response.blob();
        if (
          !/^image\/(jpeg|png|webp|gif|avif)$/i.test(blob.type) ||
          blob.size > 8 * 1024 * 1024 ||
          controller.signal.aborted
        )
          throw new Error("Invalid photo.");
        entry.objectUrl = URL.createObjectURL(blob);
        return entry.objectUrl;
      })
      .finally(() => clearTimeout(timeout));
    photo = entry;
    photos.set(url, photo);
  }
  photo.refs++;
  const entry = photo;
  let released = false;
  return {
    ready: entry.ready,
    release() {
      if (released) return;
      released = true;
      if (--entry.refs === 0) {
        entry.controller.abort();
        if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
        if (photos.get(url) === entry) photos.delete(url);
      }
    },
  };
}
