import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { join } from "node:path";

const outDir = "dist-lambda";

// Step 1: Bundle the Lambda handler with esbuild
await mkdir(outDir, { recursive: true });
await build({
  entryPoints: ["src/lambda/handler.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: join(outDir, "handler.mjs"),
  external: ["@aws-sdk/*"],
  minify: false,
  sourcemap: false,
});

console.log(`✓ Bundled src/lambda/handler.ts → ${outDir}/handler.mjs`);

// Step 2: Create dist-lambda/lambda.zip containing handler.mjs
const handlerPath = join(outDir, "handler.mjs");
const zipPath = join(outDir, "lambda.zip");
const fileData = await readFile(handlerPath);
const zipBytes = createZip("handler.mjs", fileData);
await writeFile(zipPath, zipBytes);

console.log(`✓ Created ${zipPath} (${zipBytes.length} bytes)`);

// --- Minimal ZIP file writer using Node.js built-in zlib ---

function createZip(fileName: string, data: Buffer): Buffer {
  const compressed = deflateRawSync(data);
  const fileNameBuf = Buffer.from(fileName, "utf-8");

  const modTime = dosTime(new Date());
  const modDate = dosDate(new Date());
  const crc = crc32(data);
  const compressedSize = compressed.length;
  const uncompressedSize = data.length;

  // Local file header
  const localHeader = Buffer.alloc(30 + fileNameBuf.length);
  localHeader.writeUInt32LE(0x04034b50, 0);   // Local file header signature
  localHeader.writeUInt16LE(20, 4);            // Version needed to extract (2.0)
  localHeader.writeUInt16LE(0, 6);             // General purpose bit flag
  localHeader.writeUInt16LE(8, 8);             // Compression method (deflate)
  localHeader.writeUInt16LE(modTime, 10);      // Last mod file time
  localHeader.writeUInt16LE(modDate, 12);      // Last mod file date
  localHeader.writeUInt32LE(crc, 14);          // CRC-32
  localHeader.writeUInt32LE(compressedSize, 18);   // Compressed size
  localHeader.writeUInt32LE(uncompressedSize, 22); // Uncompressed size
  localHeader.writeUInt16LE(fileNameBuf.length, 26); // File name length
  localHeader.writeUInt16LE(0, 28);            // Extra field length
  fileNameBuf.copy(localHeader, 30);

  // Central directory header
  const centralHeader = Buffer.alloc(46 + fileNameBuf.length);
  centralHeader.writeUInt32LE(0x02014b50, 0);  // Central directory signature
  centralHeader.writeUInt16LE(20, 4);          // Version made by
  centralHeader.writeUInt16LE(20, 6);          // Version needed to extract
  centralHeader.writeUInt16LE(0, 8);           // General purpose bit flag
  centralHeader.writeUInt16LE(8, 10);          // Compression method (deflate)
  centralHeader.writeUInt16LE(modTime, 12);    // Last mod file time
  centralHeader.writeUInt16LE(modDate, 14);    // Last mod file date
  centralHeader.writeUInt32LE(crc, 16);        // CRC-32
  centralHeader.writeUInt32LE(compressedSize, 20);   // Compressed size
  centralHeader.writeUInt32LE(uncompressedSize, 24); // Uncompressed size
  centralHeader.writeUInt16LE(fileNameBuf.length, 28); // File name length
  centralHeader.writeUInt16LE(0, 30);          // Extra field length
  centralHeader.writeUInt16LE(0, 32);          // File comment length
  centralHeader.writeUInt16LE(0, 34);          // Disk number start
  centralHeader.writeUInt16LE(0, 36);          // Internal file attributes
  centralHeader.writeUInt32LE(0, 38);          // External file attributes
  centralHeader.writeUInt32LE(0, 42);          // Relative offset of local header
  fileNameBuf.copy(centralHeader, 46);

  // End of central directory record
  const centralDirOffset = localHeader.length + compressed.length;
  const centralDirSize = centralHeader.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);           // End of central directory signature
  eocd.writeUInt16LE(0, 4);                    // Number of this disk
  eocd.writeUInt16LE(0, 6);                    // Disk where central directory starts
  eocd.writeUInt16LE(1, 8);                    // Number of central directory records on this disk
  eocd.writeUInt16LE(1, 10);                   // Total number of central directory records
  eocd.writeUInt32LE(centralDirSize, 12);      // Size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16);    // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);                   // Comment length

  return Buffer.concat([localHeader, compressed, centralHeader, eocd]);
}

function dosTime(date: Date): number {
  return ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
}

function dosDate(date: Date): number {
  return ((((date.getFullYear() - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
