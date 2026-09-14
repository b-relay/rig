import { expect, test } from "bun:test";
import { inheritedEnvironment } from "../src/daemon/environment";

test("only the login basics are inherited from the installing shell; tokens and session state stay behind", () => {
  expect(
    inheritedEnvironment({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/dev",
      USER: "dev",
      LOGNAME: "dev",
      SHELL: "/bin/zsh",
      TMPDIR: "/var/folders/x",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      TZ: "UTC",
      GITHUB_TOKEN: "ghp_secret",
      AWS_SECRET_ACCESS_KEY: "aws",
      TERM_SESSION_ID: "w0t1",
      RIG_ROOT: "/tmp/rig-root",
      RIG_DAEMON_CHILD: "1",
      EMPTY: undefined,
    }),
  ).toEqual({
    PATH: "/usr/bin:/bin",
    HOME: "/Users/dev",
    USER: "dev",
    LOGNAME: "dev",
    SHELL: "/bin/zsh",
    TMPDIR: "/var/folders/x",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    TZ: "UTC",
  });
  expect(inheritedEnvironment({})).toEqual({});
});
