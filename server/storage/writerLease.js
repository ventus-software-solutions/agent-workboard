import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const WRITER_LEASE_FILE = ".workboard-writer.lock";
const INITIALIZING_GRACE_MS = 5_000;

export function writerLeasePath(dataDir) {
  return path.join(path.resolve(dataDir), WRITER_LEASE_FILE);
}

export async function acquireWriterLease(
  dataDir,
  {
    owner = "workboard",
    pid = process.pid,
    now = () => new Date(),
    isPidAlive = defaultIsPidAlive,
    beforePublish = null
  } = {}
) {
  const resolvedDataDir = path.resolve(dataDir);
  const leasePath = writerLeasePath(resolvedDataDir);
  const token = randomUUID();
  const pendingPath = `${leasePath}.pending-${pid}-${token}`;
  const leaseContents = `${JSON.stringify(
    { schemaVersion: 1, token, pid, owner, acquiredAt: now().toISOString() },
    null,
    2
  )}\n`;
  await mkdir(resolvedDataDir, { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await publishCompleteLease({ pendingPath, leasePath, leaseContents, beforePublish });

      let released = false;
      return {
        path: leasePath,
        token,
        pid,
        owner,
        async release() {
          if (released) return false;
          released = true;
          const current = await readLease(leasePath);
          if (current?.token !== token) return false;
          await unlink(leasePath).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
          return true;
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const existing = await readLease(leasePath);
    const fileStat = await stat(leasePath).catch(() => null);
    const initializing = !existing && fileStat && now().getTime() - fileStat.mtimeMs < INITIALIZING_GRACE_MS;
    if (initializing || (existing?.pid && isPidAlive(existing.pid))) {
      throw writerActiveError(leasePath, existing);
    }

    const stalePath = `${leasePath}.stale-${pid}-${randomUUID()}`;
    try {
      await rename(leasePath, stalePath);
      await unlink(stalePath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  throw writerActiveError(leasePath, await readLease(leasePath));
}

async function publishCompleteLease({ pendingPath, leasePath, leaseContents, beforePublish }) {
  let handle;
  try {
    handle = await open(pendingPath, "wx");
    await handle.writeFile(leaseContents, "utf8");
    await handle.sync();
    await beforePublish?.({ handle, pendingPath, leasePath });
    await handle.close();
    handle = null;

    // A hard-link create is atomic and refuses to replace an existing path on
    // both POSIX and Windows. The public lease therefore appears only after
    // its complete metadata is durable in a same-directory file.
    await link(pendingPath, leasePath);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(pendingPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function readLease(leasePath) {
  try {
    const parsed = JSON.parse(await readFile(leasePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function defaultIsPidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function writerActiveError(leasePath, existing) {
  return Object.assign(
    new Error(
      `Workboard data directory already has an active writer${existing?.owner ? ` (${existing.owner}` : ""}${
        existing?.pid ? ` pid ${existing.pid}` : ""
      }${existing?.owner ? ")" : ""}. Refusing to start another store process; use the running HTTP daemon for mutations.`
    ),
    {
      code: "WORKBOARD_WRITER_ACTIVE",
      status: 409,
      leasePath,
      owner: existing?.owner || "unknown",
      ownerPid: existing?.pid || null
    }
  );
}
