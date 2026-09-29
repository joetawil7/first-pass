---
name: jev
description: Sets up, checks or changes the optional Jev judge, the TypeSafe decision model that ship-check asks about review findings (is this real harm, is a small one worth fixing now, what proof does a small fix need). Shows whether it is on for each repo, which key it uses, switches it on or off, and sends one test request. Runs only when the user types it.
disable-model-invocation: true
argument-hint: <nothing, "off", "on", or what to change>
---

# jev

Jev is TypeSafe's decision model: it picks one option from a list and says how sure it is.
With the Claude Code plugin, `ship-check` can ask it three things about a review's findings:

- **harm**: does this finding do real harm (money, data, a side effect done twice or sent
  wrong, security, legal, a crash, stuck work, or the change not doing its job)? Jev can
  make a finding real harm. It can never clear one the review named, and an answer below
  its confidence floor, or any failure, leaves the call to the rules.
- **priority**: for the list of smaller findings, which to recommend fixing now.
- **proof**: for a small fix the user picked, the least proof it needs (the repo's checks
  only, a unit test, a test against the real database or service, or a browser test). A
  real-harm fix always gets the full proof.

Without the judge, the rules make each call as written. Nothing here is needed to use
first-pass.

## What leaves the machine

For each finding asked about: its scenario, its worst case, who meets it and, for proof,
the fix in one line, after secrets, emails and phone numbers are blanked. They go to
TypeSafe's API (`https://api.typesafe.ai/v1/systemone`) with the key. TypeSafe charges per
word sent; check the current price on its models page (https://docs.typesafe.ai/models)
before telling the user a number. Its data terms: https://docs.typesafe.ai/legal.

## 1. Where it stands

For the current folder, and for one repo of each group the user keeps apart (two companies
with separate accounts):

```
node "${CLAUDE_SKILL_DIR}/../../scripts/cli.mjs" jev status <repo>
```

It prints on or off, why, where the key comes from (a variable name and a file, never the
key) and the config file's path.

## 2. What the user wants

From what they typed (nothing: show the status and ask; "off" or "on": do that), or ask in
one message:

- **Do they have a Jev API key?** If not, say where one comes from (TypeSafe's console,
  https://console.typesafe.ai/keys) and stop.
- **Where is it set?** The name of the variable that holds it, and whether it is in the
  environment or in an env file (the file's path; it must be one git ignores). Never ask for
  the key itself; if one is pasted, don't repeat it, and say it should be rotated.
- **For which repos?** One key for everything, or a key per group of repos when they belong
  to separate accounts (then every group is named, and a repo no entry names has the judge
  off).

## 3. Write the config

The config file is the path `jev status` printed (`first-pass/jev.json` in the Claude Code
config folder, `~/.claude` unless `CLAUDE_CONFIG_DIR` says otherwise). Read it first if it
exists and change only what the user asked:

One key for everything:

```json
{ "keys": [{ "env": "TYPESAFE_API_KEY" }] }
```

A key per account:

```json
{
  "keys": [
    { "env": "COMPANY_A_TYPESAFE_API_KEY", "file": "/abs/path/company-a/.env.local", "repos": ["/abs/path/company-a", "/abs/path/company-a-site"] },
    { "env": "COMPANY_B_TYPESAFE_API_KEY", "repos": ["/abs/path/company-b"] }
  ]
}
```

- `env`: the variable's name. It is read from the environment first, then from `file`.
- `file`: optional, an env file holding `NAME=value`.
- `repos`: absolute paths. The deepest one that holds the folder wins, and a checkout of a
  named repo elsewhere (a worktree, a clean checkout in the temp folder) counts as that repo,
  even inside a folder named for another key. An entry without `repos` covers every folder,
  and is allowed only as the only entry: with separate accounts, a folder no entry names has
  the judge off, never another account's key.
- With separate accounts, name each repo's own folder. Never name a folder that also holds
  another account's repos (the main folder above them all, say): a named folder covers every
  folder inside it, new repos included, so a repo cloned there later would get that key.
- `"off": true` switches the judge off everywhere and keeps the rest. `"model"` pins a
  version (default `jev-latest`); pin one when you have tuned against it.
- `"url"`: only to send somewhere other than TypeSafe's endpoint (https, or this machine for
  a test server); `jev status` then shows it. Leave it out otherwise, and remove one the user
  did not ask for.
- Before writing a `file` path, check git ignores it: `git -C <its repo> check-ignore -q
  <file>`. If it is not ignored, say so and don't use it.

## 4. Check it works

Run `jev status <repo>` again for each group, then once per key:

```
node "${CLAUDE_SKILL_DIR}/../../scripts/cli.mjs" jev test <repo>
```

It sends one made-up finding (no code, no customer data) and prints Jev's pick and how sure
it was. A refused key or no answer prints why.

## 5. Report

```
Jev judge: <on for <repos> (key from <NAME>, in the environment | in <file>) | off, <why>>, one line per key
Verified: jev test → <Jev's pick and confidence, or the error>, one line per key
Config: <the file, and what changed>
```
