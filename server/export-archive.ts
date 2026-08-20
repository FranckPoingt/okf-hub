/// <reference lib="deno.ns" />

export type ExportFile = { path: string; body: string | Uint8Array };

const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
const MAX_EXPORT_FILES = 5_000;
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

export class ExportArchiveError extends Error {}

function zipPath(path: string) {
  const bytes = encoder.encode(path);
  if (
    !path || path.startsWith("/") || path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new ExportArchiveError(`Unsafe export path: ${path}`);
  if (bytes.length > 65_535) {
    throw new ExportArchiveError(`Export path is too long: ${path}`);
  }
  return bytes;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
  };
}

function write16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function write32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

async function deflate(bytes: Uint8Array) {
  const stream = new Blob([Uint8Array.from(bytes).buffer]).stream().pipeThrough(
    new CompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function createZip(files: ExportFile[]) {
  if (files.length > MAX_EXPORT_FILES) {
    throw new ExportArchiveError(`Export exceeds ${MAX_EXPORT_FILES} files`);
  }
  const encoded = await Promise.all(files.map(async (file) => {
    const body = typeof file.body === "string"
      ? encoder.encode(file.body)
      : file.body;
    return {
      body,
      compressed: await deflate(body),
      crc: crc32(body),
      name: zipPath(file.path),
    };
  }));
  const totalBodyBytes = encoded.reduce(
    (size, file) => size + file.body.length,
    0,
  );
  if (totalBodyBytes > MAX_EXPORT_BYTES) {
    throw new ExportArchiveError("Export exceeds 256 MiB");
  }
  const localSize = encoded.reduce(
    (size, file) => size + 30 + file.name.length + file.compressed.length,
    0,
  );
  const centralSize = encoded.reduce(
    (size, file) => size + 46 + file.name.length,
    0,
  );
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  const { date, time } = dosDateTime(new Date());
  let offset = 0;
  const localOffsets: number[] = [];
  for (const file of encoded) {
    localOffsets.push(offset);
    write32(view, offset, 0x04034b50);
    write16(view, offset + 4, 20);
    write16(view, offset + 6, 0x0800);
    write16(view, offset + 8, 8);
    write16(view, offset + 10, time);
    write16(view, offset + 12, date);
    write32(view, offset + 14, file.crc);
    write32(view, offset + 18, file.compressed.length);
    write32(view, offset + 22, file.body.length);
    write16(view, offset + 26, file.name.length);
    output.set(file.name, offset + 30);
    output.set(file.compressed, offset + 30 + file.name.length);
    offset += 30 + file.name.length + file.compressed.length;
  }
  const centralOffset = offset;
  encoded.forEach((file, index) => {
    write32(view, offset, 0x02014b50);
    write16(view, offset + 4, 20);
    write16(view, offset + 6, 20);
    write16(view, offset + 8, 0x0800);
    write16(view, offset + 10, 8);
    write16(view, offset + 12, time);
    write16(view, offset + 14, date);
    write32(view, offset + 16, file.crc);
    write32(view, offset + 20, file.compressed.length);
    write32(view, offset + 24, file.body.length);
    write16(view, offset + 28, file.name.length);
    write32(view, offset + 42, localOffsets[index]);
    output.set(file.name, offset + 46);
    offset += 46 + file.name.length;
  });
  write32(view, offset, 0x06054b50);
  write16(view, offset + 8, encoded.length);
  write16(view, offset + 10, encoded.length);
  write32(view, offset + 12, centralSize);
  write32(view, offset + 16, centralOffset);
  // ponytail: archives are assembled in memory; stream entries if real
  // workspace exports approach the explicit 256 MiB ceiling.
  return output;
}
