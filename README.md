# usage-bars

A Claude Code mod that draws colored usage bars above the prompt:

- **Context window**: how full the current conversation is
- **Session · 5h** and **Weekly · all models**: your plan's rate limits, with reset times
- **Weekly · Fable** (and any other per-model weekly limit your plan has)
- **Models this session**: each model's share of the tokens used this session
- **Cost**: what the session has cost so far
- **Use reset** button, shown only when Claude offers you a limit reset; it runs Claude Code's own `/limit-reset`, which asks you to confirm

Bars turn green, yellow (50%+) and red (80%+). **Collapse** shrinks the band to one line.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install usage-bars --marketplace nhridoy/claude-usage-bars
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install usage-bars --marketplace nhridoy/claude-usage-bars
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `nhridoy/claude-usage-bars`, then Add plugin.

## Notes

- The rate-limit bars and reset button need a Claude subscription login. With an API key you get the context and cost bars only.
- Per-model limits and reset offers come from Anthropic's internal, undocumented usage endpoint (`api.anthropic.com/api/oauth/usage`), asked at most once a minute. Claude Code attaches your login to that request itself; the mod never sees your token. If the endpoint changes, those bars simply disappear.
- Model share counts this session's replies only, subagents included, and starts at zero in a new session.

## Develop

```
claude plugin validate .
claude plugin test .
```
