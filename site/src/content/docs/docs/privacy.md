---
title: Privacy policy
description: My Own Suite collects nothing about you — here is the whole policy, plus the honest fine print about the third-party apps in the catalog.
---

This is the part of a product where you're normally asked to accept things. There is remarkably little to ask.

## Inside My Own Suite: nothing

There is no My Own Suite account, no sign-up, and no server of ours that your installation reports back to. Your data lives on your own disk, and the platform contains no telemetry, no analytics, and no crash reporting — with no way for us to quietly add any, because the code is open source and every change is public. We don't know that you installed My Own Suite, and we like it that way.

Your suite does reach outward for a few things, and they are all the boring kind:

- **GitHub** — for platform updates, and every few hours to check the signed app catalog and the security-advisory feed. That check is what lets MOS tell you an app has an update, or a published problem, without you going looking.
- **Container registries** — to download app images when you install or update an app.
- **Cloudflare** — only if you set up a real domain with HTTPS, and only to prove the domain is yours.

Those services see the ordinary metadata any download involves: your server's address, and what it asked for. A container registry therefore knows an image was pulled, exactly as it would for anyone using Docker. But nothing about how you *use* your suite — your files, your photos, your passwords, who signs in, what you do all day — ever leaves it.

## This website

The landing page uses [Umami](https://umami.is/), an open-source analytics tool we host ourselves, to count visits anonymously: no cookies, no cross-site tracking, no personal profiles, and the numbers stay on our own instance. The docs pages you're reading have no analytics at all.

## The apps are a different story — please read this part

The apps in the catalog (Immich, Seafile, Vaultwarden, and the rest) are built by other teams and organizations, not by us. We package and configure them; we don't write them, and we cannot control or guarantee what happens inside someone else's software.

So rather than ask you to take our word for it, we publish what we actually know. **Every app in the catalog carries a Privacy Posture assessment**: a bounded, evidence-backed review of one exact version of that app, graded from A to D, with the evidence, the sources, and the unanswered questions all published alongside it. Where an app has a supported switch for its telemetry, we turn it off in the MOS packaging and record that as evidence. The grade is derived from the findings — we can't simply award a good one, and an app cannot claim one for itself.

The assessment is part of what makes an app a catalog app in the first place: an app joins the catalog when its review is done, not before. You'll see the grade in the catalog and on the app's tile inside your own server, and [How we assess](/docs/privacy/how-we-assess/) explains exactly what it does and does not mean.

A rating is not a guarantee — it is honest, bounded evidence about one exact version of an app. Double-checking an app's own privacy policy is still worth your time: every app's page in [the app catalog](/docs/apps/) links to its official website, where you'll find its policy.

## Apps you bring yourself

MOS also lets you install an app package from a GitHub repository you paste in yourself. Those are labelled **External · Unverified** everywhere they appear, and the label is literal: we have not reviewed the package, we make no privacy claim about it, and MOS will not let it dress itself up as reviewed or borrow an official app's identity.

Two things worth knowing before you do it. Installing builds the package from the publisher's own instructions, which run on your server with network access — that is real trust you're extending to a stranger, and MOS says so plainly at the point you decide rather than afterwards. And MOS constrains what such a package may ask for: no privileged containers, no access to the Docker socket, no host filesystem, no reaching into another app's secrets.

## Don't take our word for it

The entire platform is open source in [the repository](https://github.com/rpuls/my-own-suite) — verify any of the above yourself, and if something looks off, open an issue.

*Last updated: July 2026.*
