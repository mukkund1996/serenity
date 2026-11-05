# learn-serenity skill

A hands-on tour of [serenity](https://getserenity.dev), the terminal map of your Claude Code sessions. It walks you through the map, the master, NEEDS YOU, the keys, sessions and PRs, one step at a time, and asks you to try each one.

serenity runs it for you once: on the first map you open after installing, a session named `learn-serenity` waits on the map with the prompt "teach me how to use serenity" ([ADR 0062](../../docs/adr/0062-first-boot-tutorial.md)). Press `Enter` on it to start.

## Take the tour again

Install the plugin in Claude Code:

```
/plugin marketplace add mukkund1996/serenity
/plugin install learn-serenity@serenity
```

Then, in a session on serenity's map, ask "teach me how to use serenity". The tour only makes sense inside serenity, since it asks you to press keys on the map.
