---
name: configure-back2vibing
description: Configure Back2Vibing alerts, sounds, volume, terminal, agent, detected workspace tools, and app startup/update behavior through a structured interview and the b2v CLI. Use when a user asks to set up or reconfigure Back2Vibing, or to configure one part of it (focus, dock, or general).
---

# Configure Back2Vibing

Configure through the typed `b2v` boundary. Never edit Back2Vibing storage, preferences, or agent hook files directly.

## Choose sections

This skill has three interview sections: **focus**, **dock**, and **general**.

Run only the sections the request names. If the request names none, run all three. Requests that mention "onboarding", "set up Back2Vibing", or "configure everything" mean all three.

| Request mentions | Run section |
| --- | --- |
| Focus, alerts, sounds, chimes, volume, prompt panel | `focus` |
| Session dock, terminal, agent, workspaces, workflow, resume | `dock` |
| General, startup, start on login, menu bar, updates | `general` |

Preflight and apply always run, whichever sections were selected. Every field outside the selected sections keeps the exact value `configure start` returned — never invent or "tidy" one.

## Preflight (always)

Run:

```bash
b2v --supports configure
```

If this fails or does not print `supported`, stop and say exactly:

> Your b2v CLI does not support configuration. Open Back2Vibing, reinstall the CLI from its CLI tab, then retry.

Then run:

```bash
b2v configure start --json
```

If it fails, surface stdout and stderr verbatim. If Back2Vibing is not open, stop and say exactly:

> Back2Vibing must be open to configure it. Open the desktop app and retry.

Parse the returned JSON. Treat `suggestedConfiguration` as the mutable working configuration. Use only the returned `terminals`, `agents`, `chimes`, `advanced.supportedResumeModes`, and capability booleans. Show returned warnings. When the `dock` section is selected and there is no terminal choice or no agent choice, stop before apply.

### Asking rules

Every question in every section below is a separate `AskUserQuestion` call in Claude Code, or the equivalent structured-question tool in other agents. Specifically:

- **One `AskUserQuestion` call per numbered step.** Do not merge several settings into a single call, and do not batch a whole section into one question.
- **Wait for each answer before asking the next.** A later question's options often depend on the previous answer — sound questions depend on the chosen style, workflow follow-ups depend on the chosen workflow.
- **Never ask in plain prose** and never infer an answer from conversation. If a step's question applies, it gets a structured question.
- **Offer only the allowed values** for that field, using the human-readable label as the option label and the wire value in the option description. Put the value already in the working configuration first and mark it as recommended.
- **Skip a step only when this file says to skip it** — an unmet capability flag, or a style of `off` suppressing its sound question. Record the skipped field exactly as `configure start` returned it.

Ask once, before the selected sections:

**Use Back2Vibing's recommended setup?**

- **Use recommended setup** — recommended
- **Customize**

If recommended is accepted, ask no section questions at all and go straight to apply.

## Section: focus

Ask each step below as its own `AskUserQuestion`, in order, updating the matching JSON field from each answer before moving on:

1. **When the agent is DONE, what should Back2Vibing do?** Update `completionStyle` using only:
   - `autofocus`: bring the agent forward
   - `interactive`: ask before switching
   - `smart_o`: smart focus behavior
   - `mac_os_notification`: macOS notification
   - `off`: nothing
2. **When the agent NEEDS INPUT, what should Back2Vibing do?** Update `permissionStyle` from the same values.
3. Ask **DONE sound** and **NEEDS INPUT sound** independently only when that event's style is not `off`. Offer Off plus only values returned in `chimes`, and set the corresponding `completionSound` or `permissionSound` to `null` for Off. When an event style is `off`, skip its sound question and set its sound to `null`.
4. **Notification volume** from 0 through 100. Update `soundVolume`.
5. Only when `canBoostVolume` is true, ask **Boost notification volume up to 200%?** Set `volumeMode` to `absolute` for Yes or `relative` for No. When boosting is unavailable, keep `relative`.
6. **Lower other audio while the alert plays?** Update `audioDucking`.
7. **Use Prompt Panel when the agent needs input?** Update `promptPanel`.

## Section: dock

Ask each step below as its own `AskUserQuestion`, in order:

1. **Preferred terminal.** Offer only returned `terminals` and store its `id` in `dock.preferredTerminal`. Whenever the current `dock.resumeMode` is `supportedTerminalNewWindow`, also set `dock.resumeTerminal` to that ID.
2. **Preferred agent.** Offer only returned `agents`, and store its `id` as the sole item in `dock.preferredAgents`.

### Optional advanced workspace creation

If none of `advanced.conductorInstalled`, `advanced.tmuxInstalled`, `advanced.zellijInstalled`, or `advanced.herdrInstalled` is true, skip the rest of this section.

Otherwise ask:

**Configure advanced workspace creation?**

- **Keep recommended workspace defaults** — recommended
- **Configure advanced**

If defaults are accepted, leave the remaining `dock` fields unchanged. If advanced is selected, ask each applicable step below as its own `AskUserQuestion`:

1. Only when `advanced.conductorInstalled` is true, ask for `dock.workspaceLauncher` and offer `terminal|conductor`. Otherwise keep `dock.workspaceLauncher` unchanged.
2. Ask for `dock.workflow`. Offer `terminal` always, plus only installed advanced workflows:
   - `tmux` when `advanced.tmuxInstalled`
   - `zellij` when `advanced.zellijInstalled`
   - `herdr` when `advanced.herdrInstalled`
3. Keep workflow and multiplexer consistent:
   - terminal → `multiplexer: none`
   - tmux → `multiplexer: tmux`
   - zellij → `multiplexer: none`
   - herdr → `multiplexer: herdr`
4. Ask only the follow-ups for the selected workflow:
   - terminal: new-worktree `tab|pane` → `terminalNewWorktreePlacement`; new-session `tab|pane` → `terminalNewSessionPlacement`
   - tmux: `perWorktree|perAgent` → `tmuxSessionMode`; new-session `window|pane` → `tmuxNewSessionPlacement`
   - zellij: new-session `tab|pane` → `zellijNewSessionPlacement`
   - herdr: no placement follow-up
5. Ask for resume behavior using only `advanced.supportedResumeModes`, and update `dock.resumeMode`. If `supportedTerminalNewWindow` is selected, set `dock.resumeTerminal` to `dock.preferredTerminal`.

Keep every non-applicable dock field unchanged.

## Section: general

Ask each step below as its own `AskUserQuestion`, in order:

1. Only when `canSetStartOnLogin` is true, ask **Launch Back2Vibing when you log in?** and update `general.startOnLogin`. When it is false, keep `general.startOnLogin` exactly as returned and tell the user start on login is unavailable in this build.
2. **Closing the window should hide to the menu bar or quit the app?** Set `general.hideToTrayOnClose` to `true` for hide, `false` for quit.
3. **Install updates in the background and restart automatically?** Update `general.backgroundAutoUpdate`.
4. **Which update channel?** Update `general.updateChannel` using only `stable` or `alpha`. Say that alpha builds ship early features and can be less stable.

## Confirm and apply once (always)

Show one concise final summary covering only the selected sections:

- focus: DONE, NEEDS INPUT, both sounds, volume/boost, audio ducking, Prompt Panel
- dock: terminal, agent, workspace launcher/workflow, placement details that apply, resume behavior
- general: start on login, close behavior, background auto-update, update channel

Ask for final confirmation with a structured question. Cancellation or rejection ends without running apply and without writing anything.

On confirmation, serialize the complete working configuration as JSON — every field, including the sections you did not run — and run exactly one apply command:

```bash
b2v configure apply --stdin <<'B2V_CONFIG'
<suggestedConfiguration JSON after edits>
B2V_CONFIG
```

Surface stdout and stderr verbatim. Claim success only when the command exits with status 0. Never run a second apply command automatically.
