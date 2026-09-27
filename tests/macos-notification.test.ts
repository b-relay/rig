import { expect, test } from "bun:test";
import type { OperatorAlert } from "../src/domain/operator-alerts";
import type { CommandRequest } from "../src/providers/contracts";
import { createMacosNotifications } from "../src/providers/macos-notification";

const alert: OperatorAlert = {
  kind: "down",
  at: "2026-09-25T14:03:58.000Z",
  title: 'pantry "live" went down at 13:58:58 UTC',
  summary:
    'web: ended by SIGTERM" & (do shell script "touch /tmp/pwned") & ". Run rig up live --project pantry.',
  detail: "detail",
  targets: [],
};

/** A runner that records the command and answers as scripted; nothing is executed and no notification is posted. */
function runner(result = { exitCode: 0, stdout: "", stderr: "" }) {
  const requests: CommandRequest[] = [];
  return {
    requests,
    run: async (request: CommandRequest) => {
      requests.push(request);
      return result;
    },
  };
}

test("the notification texts reach osascript as arguments after the script, never as script source", async () => {
  const fake = runner();
  await createMacosNotifications({ run: fake.run }).send(alert);
  const [request] = fake.requests;
  const command = request!.command;
  expect(command[0]).toBe("/usr/bin/osascript");
  const script = command.slice(1, command.indexOf("--"));
  expect(script.filter((_, index) => index % 2 === 1).join("\n")).toBe(
    [
      "on run argv",
      "display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)",
      "end run",
    ].join("\n"),
  );
  expect(command.slice(command.indexOf("--") + 1)).toEqual([
    "Rig",
    alert.title,
    alert.summary,
  ]);
  expect(request!.timeoutMs).toBe(10_000);
});

test("long texts are cut short for Notification Center", async () => {
  const fake = runner();
  await createMacosNotifications({ run: fake.run }).send({
    ...alert,
    summary: "x".repeat(500),
  });
  const body = fake.requests[0]!.command.at(-1)!;
  expect(body).toHaveLength(240);
  expect(body.endsWith("…")).toBe(true);
});

test("a failed osascript rejects with ALERT_DELIVERY, its last error line and the permission hint", async () => {
  const fake = runner({
    exitCode: 1,
    stdout: "",
    stderr: "execution error: Not authorized. (-1743)\n",
  });
  await expect(
    createMacosNotifications({ run: fake.run }).send(alert),
  ).rejects.toMatchObject({
    code: "ALERT_DELIVERY",
    message:
      "osascript could not post the macOS notification (exit 1: execution error: Not authorized. (-1743)).",
    hint: expect.stringContaining("System Settings > Notifications"),
  });
});
