---
title: Keeping copies
description: Why one copy is not a backup, what a drive you unplug protects against that nothing else does, and what MOS can and cannot do for you.
---

This page is about backups in general, not about which button to press. If you want the buttons, read [Back up and restore](/docs/guides/backup-restore/).

It is short on purpose. You do not need to become a systems administrator to keep your photos.

## One copy is not a backup

A copy that lives in the same place as the original is not a backup of it. The drive inside your server and the data on your server die together — in a fire, a flood, a theft, a power surge, or a disk failure that takes the whole machine with it.

The word "backup" only means anything once the copy is somewhere the original is not.

## Two different things go wrong

They need different answers, and this is the part that catches people out.

**The machine stops working.** A dead disk, a dropped server, a house fire. Any copy that is somewhere else covers this — a drive in a drawer, a bucket at a storage provider, a drive at your sister's house.

**Something deletes your data.** Ransomware, an intruder, or you, at eleven at night, sure that you did not need that folder. Here a copy your server can reach is not much of a copy: whatever got into the server can reach it too.

Most people who think they are covered are covered for the first one only.

## Why a bucket alone does not cover the second one

MOS writes to your bucket with credentials it keeps on the server. That is what makes automatic backups work without you.

It is also the limit. Anything MOS can write to, MOS can delete, and anything running on your server with the same access can delete it too. Ransomware does not even have to delete anything: it can encrypt your live data and wait while MOS faithfully backs up the encrypted version, until the good copies age out on their own.

There is no clever setting in MOS that fixes this. Any protection MOS can undo from the server, an attacker on that server can undo as well. Be suspicious of anyone who tells you otherwise about any product.

## The drive you unplug

A drive that is not plugged in cannot be encrypted, deleted, or ransomed. Nothing can reach it, because it is in a drawer.

That is the whole trick, and it is the only protection against the second kind of problem that anyone can perform without learning anything:

1. Plug a USB drive into your server.
2. Back up to it from the Backup & Restore screen.
3. Unplug it and put it somewhere else — a drawer, a safe, a different building.
4. Do it again sometimes.

Two drives are better than one: back up to one, take it away, and bring the other one back next time. Then a drive that fails, or one you lose, never leaves you with nothing.

MOS helps where it can. It remembers the drives you have backed up to, tells you when you last wrote to each one, says which of your copies something on your server could erase, and reminds you to unplug a drive when it has just been written to. It will not nag you into a routine and it will never do this part for you: the drawer is out of its reach, which is exactly why it works.

## If your storage provider offers it, turn on immutability

Some providers — anything with S3 Object Lock, or Backblaze B2's file lock — can be told to refuse deletions for a number of days, and some let you create an access key that can write but not delete. If your provider offers either, turning it on is worth ten minutes of your evening. It closes most of the gap above for the copy in the bucket.

MOS does not set this up for you, and does not depend on it. It is configured in your provider's console, it works differently at every provider, and plenty of providers do not offer it at all.

## Try a restore before you need one

An untested backup is a belief, not a copy. Once, on a quiet weekend, open a restore point and restore it — ideally onto a spare machine. What you are checking is not really the file: it is that you know how, and that your recovery key is where you thought it was.

If a restore is the first thing you ever do with a backup, you will be learning it on the worst day of your year.

## Where your recovery key goes

Your backups are encrypted with your recovery key, and nobody — including us — can open them without it. That is the point, and it is also the sharp edge: if the key is gone and the server is gone, the data is gone.

Keep the key somewhere that is not the server. A password manager on another device, or paper somewhere that is not the building the server is in. If you keep it on the server you are backing up, you have not kept it.

## The honest part

Nobody can build something that makes losing data impossible, and anyone selling you that is selling you something.

What you can do is stop being one accident away from losing everything. Two copies, one of them out of reach, is most of the distance from "I lost everything" to "I lost an afternoon". You do not need more than that, and you do not need to do it perfectly.
