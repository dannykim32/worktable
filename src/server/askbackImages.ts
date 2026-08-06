// Ask-back image store (paste-an-image, single image per ask-back v1).
// Bytes live at <workspaceDir>/askback-images/<id> (0600, dir 0700) with a
// `<id>.mime` sidecar holding the SNIFFED mime. The magic-byte sniff is the
// type authority at the boundary: a client-declared content-type is never
// trusted, and non-images are rejected, not coerced (reject-not-drop).
//
// Residual risk (inherent, no mitigation): an image can contain TEXT the model
// will read — prompt injection via image content. The bytes can't script or
// execute anywhere; they only ever reach the model as an MCP image block and
// the canvas as a blob: URL.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  IMAGE_MAX_BYTES,
  IMAGE_MIME_ALLOWED,
  isImageId,
} from "../shared/constraints.js";

/** Thrown by save() for a non-image body (→ 415 at the route). */
export class NotAnImageError extends Error {}
/** Thrown by save() for an oversize body (→ 413 at the route). */
export class ImageTooLargeError extends Error {}

/** Identify an image by its magic bytes; return the canonical mime or null.
 *  This — not any declared header — decides what the bytes are. */
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 4).equals(PNG_MAGIC)) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG_MAGIC)) {
    return "image/jpeg";
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(GIF_MAGIC)) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).equals(RIFF_MAGIC) &&
    bytes.subarray(8, 12).equals(WEBP_MAGIC)
  ) {
    return "image/webp";
  }
  return null;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const GIF_MAGIC = Buffer.from("GIF8", "ascii");
const RIFF_MAGIC = Buffer.from("RIFF", "ascii");
const WEBP_MAGIC = Buffer.from("WEBP", "ascii");

export interface StoredImage {
  mime: string;
  bytes: Buffer;
}

export class ImageStore {
  private readonly dir: string;

  constructor(workspaceDir: string) {
    this.dir = join(workspaceDir, "askback-images");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // mkdir mode is masked by umask and skipped for a pre-existing dir; pin it.
    chmodSync(this.dir, 0o700);
  }

  /** Sniff, size-check, then persist. Mints a 128-bit hex id. */
  save(bytes: Buffer): { id: string; mime: string; bytes: number } {
    const mime = sniffImageMime(bytes);
    if (mime === null || !IMAGE_MIME_ALLOWED.has(mime)) {
      throw new NotAnImageError(
        "not a supported image (png, jpeg, gif, webp — checked by content, not header)",
      );
    }
    if (bytes.length > IMAGE_MAX_BYTES) {
      throw new ImageTooLargeError(
        `image is ${bytes.length} bytes; maximum is ${IMAGE_MAX_BYTES}`,
      );
    }
    const id = randomBytes(16).toString("hex");
    writeFileSync(join(this.dir, id), bytes, { mode: 0o600 });
    writeFileSync(join(this.dir, `${id}.mime`), mime, { mode: 0o600 });
    return { id, mime, bytes: bytes.length };
  }

  /** Load an image by id. The id is regex-gated (^[0-9a-f]{32}$) BEFORE any
   *  filesystem path is built — a traversal-shaped id resolves to nothing. */
  get(id: unknown): StoredImage | null {
    if (!isImageId(id)) return null;
    const path = join(this.dir, id);
    const mimePath = join(this.dir, `${id}.mime`);
    if (!existsSync(path) || !existsSync(mimePath)) return null;
    const mime = readFileSync(mimePath, "utf8").trim();
    if (!IMAGE_MIME_ALLOWED.has(mime)) return null;
    return { mime, bytes: readFileSync(path) };
  }

  has(id: unknown): boolean {
    return this.get(id) !== null;
  }
}
