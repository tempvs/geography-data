import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { readCatalogue } from "./catalogue.js";

type ManifestFile = { sha256?: string; bytes?: number };
type BundleManifest = {
  artifactId?: string;
  transformVersion?: number;
  files?: Record<string, ManifestFile>;
  summary?: { duplicateClusters?: number };
};

type ReleaseDescriptor = {
  version: 1;
  artifactId: string;
  manifestSha256: string;
  files: Record<string, { sha256: string; bytes: number }>;
};

export type VerifiedBundle = {
  artifactId: string;
  manifest: BundleManifest;
  files: Record<string, { sha256: string; bytes: number; content: Buffer }>;
};

export type PublishResult = {
  artifactId: string;
  prefix: string;
  uploaded: string[];
  existing: string[];
  preview: boolean;
};

/** Verify an immutable, reviewed bundle before either publishing it or handing
 * it to the Map import command. This intentionally rejects unresolved
 * duplicate clusters rather than making S3 a place for raw working data. */
export async function verifyReviewedBundle(
  directory: string,
): Promise<VerifiedBundle> {
  const manifestContent = await readFile(join(directory, "manifest.json"));
  const manifest = JSON.parse(manifestContent.toString("utf8")) as BundleManifest;
  if (!manifest.artifactId || !/^geo-v\d+-[a-f0-9]{12,64}$/i.test(manifest.artifactId))
    throw new Error("Bundle manifest has no valid immutable artifactId.");
  if ((manifest.summary?.duplicateClusters ?? 0) > 0)
    throw new Error("Bundle has unresolved duplicate clusters and cannot be published.");
  const listed = manifest.files ?? {};
  if (!listed["catalogue.jsonl"]?.sha256)
    throw new Error("Bundle manifest has no catalogue.jsonl checksum.");

  const files: VerifiedBundle["files"] = {};
  for (const [relativePath, metadata] of Object.entries(listed)) {
    if (!isSafeRelativePath(relativePath) || !metadata.sha256)
      throw new Error(`Bundle manifest has an invalid file entry: ${relativePath}`);
    const content = await readFile(join(directory, relativePath));
    const sha256 = digest(content);
    if (sha256 !== metadata.sha256)
      throw new Error(`Bundle checksum mismatch: ${relativePath}`);
    files[relativePath] = { sha256, bytes: content.byteLength, content };
  }
  for (const required of ["summary.json", "duplicates.json", "manifest.json"]) {
    const content = required === "manifest.json" ? manifestContent : await readFile(join(directory, required));
    files[required] = { sha256: digest(content), bytes: content.byteLength, content };
  }
  // Hashes prove byte identity; the catalogue parser separately proves that a
  // release still has coordinates, labels, provenance, and licence metadata.
  await readCatalogue(join(directory, "catalogue.jsonl"));
  return { artifactId: manifest.artifactId, manifest, files };
}

/** Publish only content-addressed reviewed artifacts. Existing remote content
 * must have the same checksum; this prevents a release key from being mutated
 * accidentally in dev, staging, or production. */
export async function publishReviewedBundle(options: {
  directory: string;
  bucket: string;
  prefix?: string;
  apply: boolean;
  client?: S3Client;
}): Promise<PublishResult> {
  const bundle = await verifyReviewedBundle(options.directory);
  const prefix = normalizedPrefix(options.prefix, bundle.artifactId);
  const client = options.client ?? new S3Client({});
  const uploaded: string[] = [];
  const existing: string[] = [];
  const descriptor: ReleaseDescriptor = {
    version: 1,
    artifactId: bundle.artifactId,
    manifestSha256: bundle.files["manifest.json"].sha256,
    files: Object.fromEntries(
      Object.entries(bundle.files).map(([path, file]) => [
        path,
        { sha256: file.sha256, bytes: file.bytes },
      ]),
    ),
  };
  const objects = {
    ...bundle.files,
    "release.json": {
      content: Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`),
      sha256: "",
      bytes: 0,
    },
  };
  objects["release.json"].sha256 = digest(objects["release.json"].content);
  objects["release.json"].bytes = objects["release.json"].content.byteLength;

  for (const [relativePath, file] of Object.entries(objects)) {
    const key = posix.join(prefix, relativePath);
    const alreadyPublished = await objectHasChecksum(client, options.bucket, key, file.sha256);
    if (alreadyPublished) {
      existing.push(relativePath);
      continue;
    }
    if (!options.apply) {
      uploaded.push(relativePath);
      continue;
    }
    await client.send(
      new PutObjectCommand({
        Bucket: options.bucket,
        Key: key,
        Body: file.content,
        ContentType: "application/json",
        Metadata: { "tempvs-sha256": file.sha256, "tempvs-artifact": bundle.artifactId },
      }),
    );
    uploaded.push(relativePath);
  }
  return { artifactId: bundle.artifactId, prefix, uploaded, existing, preview: !options.apply };
}

/** Download a single immutable artifact to a fresh local directory and verify
 * every byte before it becomes a candidate for another environment's import. */
export async function fetchReviewedBundle(options: {
  bucket: string;
  artifactId: string;
  outDirectory: string;
  prefix?: string;
  client?: S3Client;
}): Promise<{ artifactId: string; files: number }> {
  if (!/^geo-v\d+-[a-f0-9]{12,64}$/i.test(options.artifactId))
    throw new Error("artifactId is invalid.");
  const client = options.client ?? new S3Client({});
  const prefix = normalizedPrefix(options.prefix, options.artifactId);
  await assertDirectoryDoesNotExist(options.outDirectory);
  const descriptorContent = await getObjectBytes(client, options.bucket, posix.join(prefix, "release.json"));
  const descriptor = JSON.parse(descriptorContent.toString("utf8")) as ReleaseDescriptor;
  if (descriptor.version !== 1 || descriptor.artifactId !== options.artifactId)
    throw new Error("Published release descriptor does not match requested artifact.");
  if (!descriptor.files || !Object.keys(descriptor.files).length)
    throw new Error("Published release descriptor has no files.");

  await mkdir(options.outDirectory, { recursive: false });
  for (const [relativePath, expected] of Object.entries(descriptor.files)) {
    if (!isSafeRelativePath(relativePath)) throw new Error("Release has an unsafe file path.");
    const content = await getObjectBytes(client, options.bucket, posix.join(prefix, relativePath));
    if (content.byteLength !== expected.bytes || digest(content) !== expected.sha256)
      throw new Error(`Published release checksum mismatch: ${relativePath}`);
    const destination = join(options.outDirectory, relativePath);
    const parent = destination.slice(0, Math.max(destination.lastIndexOf("\\"), destination.lastIndexOf("/")));
    if (parent && parent !== options.outDirectory) await mkdir(parent, { recursive: true });
    await writeFile(destination, content);
  }
  await verifyReviewedBundle(options.outDirectory);
  return { artifactId: options.artifactId, files: Object.keys(descriptor.files).length };
}

function normalizedPrefix(prefix: string | undefined, artifactId: string): string {
  const trimmed = (prefix ?? "tempvs/geography").replace(/^\/+|\/+$/g, "");
  if (!trimmed || !trimmed.split("/").every(isSafeRelativePath))
    throw new Error("prefix is invalid.");
  return posix.join(trimmed, artifactId);
}

async function objectHasChecksum(
  client: S3Client,
  bucket: string,
  key: string,
  expectedChecksum: string,
): Promise<boolean> {
  try {
    const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const existingChecksum = response.Metadata?.["tempvs-sha256"];
    if (existingChecksum === expectedChecksum) return true;
    throw new Error(`Refusing to overwrite immutable published object: s3://${bucket}/${key}`);
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = error instanceof Error ? error.name : "";
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") return false;
    throw error;
  }
}

async function getObjectBytes(client: S3Client, bucket: string, key: string): Promise<Buffer> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error(`Published object has no body: s3://${bucket}/${key}`);
  return Buffer.from(await response.Body.transformToByteArray());
}

async function assertDirectoryDoesNotExist(directory: string): Promise<void> {
  try {
    await access(directory);
    throw new Error(`Output directory already exists: ${directory}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Output directory")) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isSafeRelativePath(path: string): boolean {
  return Boolean(path) && !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) => !part || part === "." || part === "..");
}
