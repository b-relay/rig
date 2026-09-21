// Demo Service for the Rig website's Preview sandbox: polls the API and logs what it saw.
const api = process.env.API_URL;
setInterval(async () => {
  try {
    const answer = await fetch(`${api}/`);
    process.stdout.write(`reconciled ${JSON.stringify(await answer.json())}\n`);
  } catch {
    process.stderr.write(`api unreachable at ${api}\n`);
  }
}, 20_000);
process.stdout.write(`worker watching ${api}\n`);

export {};
