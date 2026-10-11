// Demo job for the Rig website's Preview sandbox: closes the day's books by asking the API once.
const api = process.env.API_URL;
try {
  const answer = await fetch(`${api}/`);
  process.stdout.write(
    `closed the day: ${JSON.stringify(await answer.json())}\n`,
  );
} catch {
  process.stderr.write(`api unreachable at ${api}\n`);
  process.exitCode = 1;
}

export {};
