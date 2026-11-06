# Sharing frames: people, organizations and projects

A paid plan at $N a month is N people
([`accounting-todo.md`](accounting-todo.md) §0.1). This is what the other
N − 1 are for: the owner invites them, puts frames in projects, and the
people in a project use its frames from their own FrameOS Cloud accounts.

Cloud only. The self-hosted backend has had organizations and projects
since before the cloud did (`backend/app/tenancy.py`): there everyone in an
organization has all of its projects, and who is in it is the operator's
business. The cloud's are the same words for the same shape, with the two
things a hosted plan needs on top: invitations, and a count of people that
a plan pays for.

## The model

```
account ──owns──▶ organization ──has──▶ projects ──hold──▶ frames
   ▲                   │                    │
   │              has members          has members
   └── a person ◀──────┴────────────────────┘
```

- **An organization is the people on one account's plan.** The account that
  pays is its owner, and an account owns at most one. It is made the first
  time the owner opens the People page, and named after them until they
  rename it.
- **A member** is another account the owner invited. Members are `admin` or
  `member`:
  - a **member** uses the frames of the projects they were added to;
  - an **admin** uses the frames of every project, and manages the people
    and the projects.
- **A project** is a set of the owner's frames and the members who use
  them. A frame is in one project or in none.
- **A frame in no project is the owner's alone.** That is every frame before
  anyone shares anything, so nothing about an account changes until its
  owner makes a project and puts a frame in it.

A frame never changes hands. A shared frame is still the owner's: it counts
against the owner's plan, it gets the owner's service keys, its scenes are
stored in the owner's account and its activity is the owner's trail. What a
member gets is access, worked out on every request from four tables
(migration `0074_organizations.sql`): `organizations`,
`organization_members`, `projects`, `project_members`, plus
`frames.project_id`. Nothing is copied onto the frame or cached, so deleting
a row is the whole revocation.

The code is `apps/auth-web/src/lib/organizations.ts` (who may use a frame)
and `organization-manage.ts` (the writes behind the People page).

## What each person may do

Every frame route asks `frameForAccount(db, accountId, frameId, need)` for
the frame, and `need` is one of four levels:

| Level | Who has it | What it covers |
|---|---|---|
| `view` | member, admin, owner | The frame, its picture, state, logs, metrics, files, scenes, activity. |
| `edit` | member, admin, owner | Scenes (install, push, update, preview), settings, schedule, files, commands and events, restart and reboot, renaming. |
| `manage` | admin, owner | The owner's switches: whether the frame gets service keys, log shipping, what the voice chat may do, local network access. |
| `owner` | owner | Deleting and revoking the frame, confirming a new one, claim codes, re-enrollment. |

**The default is `owner`.** A call that does not say what it needs reaches
the owner's frames only, so a new route shares nothing until someone decides
it should. A frame a person may not use at the level a route asks for
answers `404 invalid_frame`, the same as a frame that is not there: a member
never learns which of the owner's other frames exist.

There is no view-only role yet. The workspace has no read-only mode to draw
one with, and a role the page cannot show is a page of buttons that fail.
The routes already tell `view` from `edit`, so it is a workspace job when it
comes.

**People in a project are trusted with what its frames hold.** A scene runs
on the frame with the service keys the frame was granted, so someone who can
change a scene can read those keys. That is why the switch that decides
whether a frame gets keys at all is `manage`, and why the People page says
so where projects are made: add the people you would give those keys.
Granting a scene a key group is `edit`, like installing the scene is.

## Seats

The plan's `people` entitlement is the number of seats, the owner's
included (`limitsForPlan`, `usage.ts`). The free plan has one, which is the
whole gate: there is no separate "sharing" flag to forget to check.

- **An invitation takes a seat** from the moment it is sent until it is
  accepted, taken back or expired (seven days). A plan cannot be oversold by
  inviting faster than people accept. Sending one with no seat left answers
  `403 people_limit`.
- **Seats go in the order people joined.** When a plan shrinks, or lapses
  to Free, the members who joined last have no access; the first ones keep
  theirs. Nobody's membership is deleted by a downgrade: the rows stay, the
  People page marks who has no seat, and access is back the moment the plan
  has room again. Without this a month of the largest plan would buy
  sharing with 28 people for good.

## Invitations

`POST /api/organization/invitations` mails the address one link:
`/account/people?invite=FOINV_…`. Only the token's hash is stored. The link
is also in the route's answer, once, so the owner can pass it on themselves.

**The link is the proof.** It was mailed to one address, but whoever holds
it and is signed in may accept it, with whichever account they use: people
sign in with another address than the one their friend knows. The People
page then shows the owner who joined, by name and address, with Remove
beside it. A link is used once; taking it back or letting it expire kills
it.

The route sends mail to an address its caller chose, so it is bounded: a
paid plan's seats, 60 invitations a day per account, and the mail never
turns the organization's name or the inviter's into a link.

An API token can read the organization and never change it: a leaked token
must not be able to invite its thief onto the owner's frames.

## Scenes

A frame's private scenes belong to the frame's account. The payload builder
has always refused anything else (`scene_private` in `frames.ts`: a scene
its publisher took private stops reaching the frames of the strangers who
installed it), and sharing keeps that one rule instead of adding a second:

- **Reading.** A person who can see a frame can read the private scenes on
  it that belong to the frame's owner (`sceneReachableThroughFrames`): the
  workspace of a shared frame draws its scenes from the same routes as
  anyone's. A photo album link inside such a scene is readable with it.
- **Editing.** A person who can edit the frame saves a new version of such
  a scene (`POST /api/account/scenes/{id}/content`). Only its content: the
  scene's page (listing, pictures, version notes) stays the owner's, and so
  does a public scene.
- **Building.** A scene built on a shared frame is saved into the owner's
  account (`POST /api/account/scenes` with `frame_id`), on the owner's
  storage, and stays on the frame whatever happens to the person's access.
  `store_scenes.created_by_account_id` records who made it, which is also
  how they may install it before any frame holds it.
- **Installing.** Public scenes go anywhere. A member's *own* private scene
  does not go on someone else's frame (`400 scene_private`): build it on
  the frame, or make it public. One of the owner's private scenes goes on
  when the person made it or can already read it on a frame they share.

## Activity

A frame's trail is its owner's. Every change a member makes is recorded on
the owner's account with the member as the actor, and the frame's Activity
panel shows it to everyone who shares the frame, by address. An IP address
is shown to the owner, and to a person on their own rows only: sharing a
frame does not share where the other people (or the frame) connect from.

Changes to the organization itself (`organization.*` events) are on the
owner's account too.

## Live updates

The hub sends a frame's events to its owner's browsers by the frame row's
account. Who a frame is shared with is not on the frame row, so for members
the hub keeps a list (`sharedFrameViewers`), rebuilt when a fleet socket
opens and on every sweep (30 s): access given or taken away reaches an open
page within one sweep. A per-frame socket opened by a member is closed when
the frame stops being shared with them. With no browser connected the sweep
does nothing extra.

The HTTP routes need none of that: they ask the tables every time.

## API

All under `/api/organization`, with the caller's own organization unless
`organization_id` names another they are an admin of.

| Route | |
|---|---|
| `GET /api/organization` | The organization the caller manages (`people`, `members`, `invitations`, `projects`, the owner's `frames`), and `memberships`: other people's organizations the caller is in. |
| `PATCH /api/organization` | `{name}` |
| `POST /api/organization/invitations` | `{email, role?, project_ids?}` → `201 {invitation, url}` |
| `DELETE /api/organization/invitations/{id}` | Take an invitation back. |
| `POST /api/organization/join` | `{token}` says what a link is for; `{token, accept: true}` joins. The token is in the body so it is in no access log. |
| `PATCH /api/organization/members/{id}` | `{role}`. The owner's alone. |
| `DELETE /api/organization/members/{id}` | Remove a member, or leave (one's own row). |
| `POST /api/organization/projects` | `{name}` |
| `PATCH /api/organization/projects/{id}` | `{name?, frame_ids?, member_ids?}`. Each list replaces the one before. |
| `DELETE /api/organization/projects/{id}` | The frames stay the owner's, shared with nobody. |

`GET /api/frames` lists the caller's own frames and then the ones shared
with them, and every frame (there and in `GET /api/frames/{id}`) carries
`access`: `{role, project, organization, owner_name?}`. The MCP server and
the AI chat's `list_frames` read the same listing.

What an admin may not do: make or unmake admins, remove another admin,
share a frame the owner has not shared (an admin never sees those), or
anything at the `owner` level.

## In the workspace

- **People** (`/account/people`, `PeoplePage.tsx` + `peopleLogic.ts`): the
  seats, the people, invitations, projects with their frames and people,
  and "Shared with you" with a way to leave. An invitation link lands here.
- A shared frame says whose it is (`FrameSharingTag`): "Shared by Olive" on
  someone else's, "Shared in Home" on the owner's own.
- What a role may not do is not offered: no Delete in a shared frame's
  menu, and the owner's switches are disabled with a line saying why
  (`utils/frameAccess.ts`, `workspaceSurfaces.ts`
  `ownerOnlyFrameMenuActions`).

## Not built

- A view-only role (above).
- Admins adding frames: a frame is enrolled into the account of the person
  who enrolls it. For a household that is right; a business will want its
  staff to enroll into the company's account.
- An organization's own scene library or photo albums. Scenes built on a
  shared frame are the owner's; a member's own library stays their own.
- Paying for someone else's AI: the AI chat on a shared frame runs on the
  account of the person typing, with their keys and their daily cap. The
  voice chat is the frame's, so it is the owner's.
- Moving a frame to another account.
