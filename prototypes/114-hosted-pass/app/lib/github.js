// PROTOTYPE for #114. A read-only installation token narrowed to the fixture repository.
import { createAppAuth } from "@octokit/auth-app";
export async function fixtureToken() {
  const auth = createAppAuth({ appId: process.env.GH_APP_ID, privateKey: Buffer.from(process.env.GH_APP_KEY_B64, "base64").toString() });
  const { token } = await auth({ type: "installation", installationId: Number(process.env.GH_INSTALLATION_ID), repositoryNames: [process.env.GH_REPO], permissions: { contents: "read" } });
  return { token, owner: process.env.GH_OWNER, repo: process.env.GH_REPO };
}
