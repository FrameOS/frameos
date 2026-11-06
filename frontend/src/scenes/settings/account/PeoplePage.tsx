import { useActions, useValues } from 'kea'
import { A } from 'kea-router'

import { Box } from '../../../components/Box'
import { Button } from '../../../components/Button'
import { Checkbox } from '../../../components/Checkbox'
import { Select } from '../../../components/Select'
import { Spinner } from '../../../components/Spinner'
import { Tag } from '../../../components/Tag'
import { TextInput } from '../../../components/TextInput'
import { urls } from '../../../urls'
import { AccountNotice, AccountPageHeader, AccountSection, AccountTable } from './AccountPageHeader'
import { formatDate } from './format'
import {
  peopleLogic,
  type InvitationOffer,
  type MemberRole,
  type Membership,
  type Organization,
  type OrganizationProject,
} from './peopleLogic'

const roleOptions = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
]

const roleNotes: Record<MemberRole, string> = {
  admin: 'Uses every project, and manages the people and projects.',
  member: 'Uses the frames of the projects they are in.',
}

function roleLabel(role: MemberRole): string {
  return role === 'admin' ? 'Admin' : 'Member'
}

// Commit a rename on Enter, like every other inline name in the workspace.
function blurOnEnter(event: React.KeyboardEvent<HTMLInputElement>): void {
  if (event.key === 'Enter') {
    event.currentTarget.blur()
  }
}

// The invitation a visitor followed a link to: what it is for, and the two
// answers. The link is spent by either.
function InvitationOfferBox({ offer }: { offer: InvitationOffer }): JSX.Element {
  const { busy } = useValues(peopleLogic)
  const { acceptOffer, declineOffer } = useActions(peopleLogic)
  const from = offer.owner_name ?? offer.organization.name
  const closed = offer.state !== 'open'
  const note =
    offer.state === 'accepted'
      ? 'This invitation was already used.'
      : offer.state === 'revoked'
      ? 'This invitation was taken back. Ask for a new one.'
      : offer.state === 'expired'
      ? 'This invitation has expired. Ask for a new one.'
      : offer.own_organization
      ? 'This invitation is to your own plan.'
      : offer.already_member
      ? `You already share frames with ${from}.`
      : null
  return (
    <Box className="mb-6 space-y-3 p-4" data-testid="people-invitation-offer">
      <div>
        <h2 className="frameos-heading text-xl font-bold">{from} invited you to share their frames</h2>
        <p className="frameos-muted mt-1 text-sm leading-relaxed">
          Accepting adds the frames they share with you to your workspace, as{' '}
          {offer.role === 'admin' ? 'an admin' : 'a member'}
          {offer.projects.length > 0 ? ` of ${offer.projects.join(', ')}` : ''}. The frames stay theirs, and you can
          leave at any time. The invitation was sent to {offer.email}.
        </p>
      </div>
      {note ? <AccountNotice tone="info">{note}</AccountNotice> : null}
      <div className="flex flex-wrap gap-2">
        {closed || offer.own_organization || offer.already_member ? null : (
          <Button size="small" color="primary" disabled={busy !== null} onClick={acceptOffer}>
            Accept
          </Button>
        )}
        <Button size="small" color="secondary" disabled={busy !== null} onClick={declineOffer}>
          {closed || offer.own_organization || offer.already_member ? 'Close' : 'Not now'}
        </Button>
      </div>
    </Box>
  )
}

function PeopleSection({ organization }: { organization: Organization }): JSX.Element {
  const { isOwner, sharingAvailable, seatsLeft, invite, inviteLink, canSendInvite, busy } = useValues(peopleLogic)
  const { setInvite, sendInvite, revokeInvitation, setMemberRole, removeMember, dismissInviteLink, copyInviteLink } =
    useActions(peopleLogic)
  const { people } = organization
  const overLimit = people.used > people.limit

  return (
    <AccountSection
      title="People"
      description={
        <>
          {people.limit === 1
            ? 'Your plan is for one person.'
            : `${people.used} of ${people.limit} people on the plan, open invitations included.`}{' '}
          A person on the plan signs in with their own FrameOS Cloud account and uses the frames of the projects you add
          them to. The frames, their scenes and their service keys stay yours.
        </>
      }
    >
      {!sharingAvailable ? (
        <AccountNotice tone="info">
          Sharing frames comes with a paid plan.{' '}
          <A href={urls.accountUsage()} className="underline">
            See the plans
          </A>
          .
        </AccountNotice>
      ) : null}
      {overLimit ? (
        <AccountNotice tone="info">
          The plan has room for {people.limit} {people.limit === 1 ? 'person' : 'people'}. The people who joined last
          have no access until the plan grows or someone is removed.
        </AccountNotice>
      ) : null}
      <Box className="p-4">
        <AccountTable head={['Person', 'Role', 'Since', '']}>
          <tr>
            <td className="py-2 pr-3 align-top">
              <span className="frameos-strong font-medium">
                {organization.owner.name || organization.owner.email || 'Owner'}
              </span>
              {organization.owner.you ? <span className="frameos-muted"> (you)</span> : null}
              {organization.owner.name && organization.owner.email ? (
                <div className="frameos-muted text-xs">{organization.owner.email}</div>
              ) : null}
            </td>
            <td className="py-2 pr-3 align-top">
              <Tag color="teal">Owner</Tag>
            </td>
            <td className="py-2 pr-3 align-top" />
            <td className="py-2 align-top" />
          </tr>
          {organization.members.map((member) => (
            <tr key={member.id}>
              <td className="py-2 pr-3 align-top">
                <span className="frameos-strong font-medium">{member.name || member.email || 'Member'}</span>
                {member.you ? <span className="frameos-muted"> (you)</span> : null}
                {member.name && member.email ? <div className="frameos-muted text-xs">{member.email}</div> : null}
                {!member.active ? (
                  <div className="text-xs text-amber-600">No seat on the plan right now: no access.</div>
                ) : null}
              </td>
              <td className="py-2 pr-3 align-top">
                {isOwner ? (
                  <div className="w-32">
                    <Select
                      aria-label={`Role of ${member.name || member.email || 'this person'}`}
                      value={member.role}
                      disabled={busy !== null}
                      options={roleOptions}
                      onChange={(role) => setMemberRole(member, role === 'admin' ? 'admin' : 'member')}
                    />
                  </div>
                ) : (
                  roleLabel(member.role)
                )}
              </td>
              <td className="py-2 pr-3 align-top">{formatDate(member.joined_at)}</td>
              <td className="py-2 text-right align-top">
                {/* An admin removes members, never another admin or themselves from here. */}
                {isOwner || (member.role === 'member' && !member.you) ? (
                  <Button size="small" color="secondary" disabled={busy !== null} onClick={() => removeMember(member)}>
                    Remove
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
          {organization.invitations.map((invitation) => (
            <tr key={invitation.id}>
              <td className="py-2 pr-3 align-top">
                <span className="frameos-strong font-medium">{invitation.email}</span>
                <div className="frameos-muted text-xs">Invited, until {formatDate(invitation.expires_at)}</div>
              </td>
              <td className="py-2 pr-3 align-top">{roleLabel(invitation.role)}</td>
              <td className="py-2 pr-3 align-top" />
              <td className="py-2 text-right align-top">
                <Button
                  size="small"
                  color="secondary"
                  disabled={busy !== null}
                  onClick={() => revokeInvitation(invitation)}
                >
                  Take back
                </Button>
              </td>
            </tr>
          ))}
        </AccountTable>
      </Box>

      {sharingAvailable ? (
        <Box className="space-y-3 p-4">
          <h3 className="frameos-strong font-semibold">Invite someone</h3>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              sendInvite()
            }}
          >
            {/* The inputs are full-width blocks: each gets a box that sizes it. */}
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-[14rem] flex-1">
                <TextInput
                  aria-label="Email address"
                  type="email"
                  autoComplete="off"
                  placeholder="name@example.com"
                  value={invite.email}
                  onChange={(email) => setInvite({ email })}
                />
              </div>
              {isOwner ? (
                <div className="w-32 shrink-0">
                  <Select
                    aria-label="Role"
                    value={invite.role}
                    options={roleOptions}
                    onChange={(role) => setInvite({ role: role === 'admin' ? 'admin' : 'member' })}
                  />
                </div>
              ) : null}
              <Button type="submit" size="small" color="primary" disabled={!canSendInvite} className="shrink-0 py-1.5">
                {busy === 'invite' ? 'Sending…' : 'Send invitation'}
              </Button>
            </div>
            <p className="frameos-muted text-xs">{roleNotes[invite.role]}</p>
            {invite.role === 'member' && organization.projects.length > 0 ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="frameos-muted text-xs">Add to</span>
                {organization.projects.map((project) => (
                  <Checkbox
                    key={project.id}
                    label={project.name}
                    value={invite.projectIds.includes(project.id)}
                    onChange={(included) =>
                      setInvite({
                        projectIds: included
                          ? [...invite.projectIds, project.id]
                          : invite.projectIds.filter((id) => id !== project.id),
                      })
                    }
                  />
                ))}
              </div>
            ) : null}
            {seatsLeft === 0 ? (
              <p className="frameos-muted text-xs">
                Every seat on the plan is taken.{' '}
                <A href={urls.accountUsage()} className="underline">
                  A larger plan
                </A>{' '}
                has room for more people.
              </p>
            ) : null}
          </form>
          {inviteLink ? (
            <AccountNotice tone="success">
              Invitation sent to {inviteLink.email}. It is valid for seven days.
              {inviteLink.url ? (
                <>
                  {' '}
                  You can also pass the link on yourself:{' '}
                  <button type="button" className="underline" onClick={copyInviteLink}>
                    copy link
                  </button>
                  .
                </>
              ) : null}{' '}
              <button type="button" className="underline" onClick={dismissInviteLink}>
                Dismiss
              </button>
            </AccountNotice>
          ) : null}
        </Box>
      ) : null}
    </AccountSection>
  )
}

function ProjectBox({
  organization,
  project,
}: {
  organization: Organization
  project: OrganizationProject
}): JSX.Element {
  const { busy } = useValues(peopleLogic)
  const { renameProject, setProjectFrame, setProjectMember, deleteProject } = useActions(peopleLogic)
  const members = organization.members.filter((member) => member.role === 'member')
  const admins = organization.members.filter((member) => member.role === 'admin')
  const disabled = busy !== null

  return (
    <Box className="space-y-4 p-4" data-testid="people-project">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[12rem] flex-1">
          <TextInput
            // Remounts when the name changes on the server, so the field
            // never shows a rename that was refused.
            key={project.name}
            aria-label="Project name"
            className="font-semibold"
            defaultValue={project.name}
            maxLength={60}
            onKeyDown={blurOnEnter}
            onBlur={(event) => renameProject(project, event.currentTarget.value)}
          />
        </div>
        <Button size="small" color="secondary" disabled={disabled} onClick={() => deleteProject(project)}>
          Delete
        </Button>
      </div>
      <div className="grid gap-4 @2xl:grid-cols-2">
        <div className="space-y-1.5">
          <div className="frameos-muted text-xs font-semibold uppercase tracking-wide">Frames</div>
          {organization.frames.length === 0 ? (
            <p className="frameos-muted text-sm">No frames yet.</p>
          ) : (
            organization.frames.map((frame) => {
              const elsewhere =
                frame.project_id && frame.project_id !== project.id
                  ? organization.projects.find((other) => other.id === frame.project_id)?.name
                  : undefined
              return (
                <div key={frame.id}>
                  <Checkbox
                    label={
                      <>
                        {frame.name}
                        {elsewhere ? <span className="frameos-muted font-normal"> (now in {elsewhere})</span> : null}
                      </>
                    }
                    disabled={disabled}
                    value={frame.project_id === project.id}
                    onChange={(included) => setProjectFrame(project, frame.id, included)}
                  />
                </div>
              )
            })
          )}
          <p className="frameos-muted text-xs">A frame is in one project at a time.</p>
        </div>
        <div className="space-y-1.5">
          <div className="frameos-muted text-xs font-semibold uppercase tracking-wide">People</div>
          {members.length === 0 && admins.length === 0 ? (
            <p className="frameos-muted text-sm">Nobody to add yet. Invite someone first.</p>
          ) : null}
          {members.map((member) => (
            <div key={member.id}>
              <Checkbox
                label={member.name || member.email || 'Member'}
                disabled={disabled}
                value={project.member_ids.includes(member.id)}
                onChange={(included) => setProjectMember(project, member.id, included)}
              />
            </div>
          ))}
          {admins.length > 0 ? (
            <p className="frameos-muted text-xs">
              Admins use every project: {admins.map((admin) => admin.name || admin.email || 'Admin').join(', ')}.
            </p>
          ) : null}
        </div>
      </div>
    </Box>
  )
}

function ProjectsSection({ organization }: { organization: Organization }): JSX.Element {
  const { newProjectName, busy } = useValues(peopleLogic)
  const { setNewProjectName, createProject } = useActions(peopleLogic)
  return (
    <AccountSection
      title="Projects"
      description="A project is a set of frames and the people who use them: Home, the office, a client's shop. Putting a frame in a project is what shares it. A frame in no project is yours alone. People in a project can change its frames' scenes and settings, and a scene can use the service keys its frame is given: add the people you would give those keys."
    >
      {organization.projects.map((project) => (
        <ProjectBox key={project.id} organization={organization} project={project} />
      ))}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          createProject()
        }}
      >
        <div className="min-w-[12rem] max-w-sm flex-1">
          <TextInput
            aria-label="New project name"
            placeholder="New project, for example Home"
            maxLength={60}
            value={newProjectName}
            onChange={setNewProjectName}
          />
        </div>
        <Button
          type="submit"
          size="small"
          color="secondary"
          className="py-1.5"
          disabled={busy !== null || newProjectName.trim().length === 0}
        >
          Add project
        </Button>
      </form>
    </AccountSection>
  )
}

function MembershipsSection({ memberships }: { memberships: Membership[] }): JSX.Element {
  const { busy, managedOrganizationId } = useValues(peopleLogic)
  const { leaveOrganization, manageOrganization } = useActions(peopleLogic)
  return (
    <AccountSection
      title="Shared with you"
      description="Other people's plans you are on. Their frames show in your workspace beside your own."
    >
      <Box className="p-4">
        <AccountTable head={['From', 'Role', 'Projects', '']}>
          {memberships.map((membership) => (
            <tr key={membership.member_id}>
              <td className="py-2 pr-3 align-top">
                <span className="frameos-strong font-medium">{membership.organization.name}</span>
                {membership.owner_name && membership.owner_name !== membership.organization.name ? (
                  <div className="frameos-muted text-xs">{membership.owner_name}</div>
                ) : null}
                {!membership.active ? (
                  <div className="text-xs text-amber-600">
                    Their plan has no seat for you right now, so their frames are not in your workspace.
                  </div>
                ) : null}
              </td>
              <td className="py-2 pr-3 align-top">{roleLabel(membership.role)}</td>
              <td className="py-2 pr-3 align-top">
                {membership.projects.length === 0 ? (
                  <span className="frameos-muted">None yet</span>
                ) : (
                  membership.projects.map((project) => (
                    <div key={project.id}>
                      {project.name}
                      <span className="frameos-muted">
                        {' '}
                        · {project.frame_count} {project.frame_count === 1 ? 'frame' : 'frames'}
                      </span>
                    </div>
                  ))
                )}
              </td>
              <td className="py-2 align-top">
                <div className="flex flex-wrap justify-end gap-1">
                  {membership.role === 'admin' && membership.active ? (
                    <Button
                      size="small"
                      color="secondary"
                      disabled={busy !== null || managedOrganizationId === membership.organization.id}
                      onClick={() => manageOrganization(membership.organization.id)}
                    >
                      Manage
                    </Button>
                  ) : null}
                  <Button
                    size="small"
                    color="secondary"
                    disabled={busy !== null}
                    onClick={() => leaveOrganization(membership)}
                  >
                    Leave
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </AccountTable>
      </Box>
    </AccountSection>
  )
}

export function PeoplePage(): JSX.Element {
  const { organization, memberships, peopleLoading, offer, isOwner, managedOrganizationId, busy } =
    useValues(peopleLogic)
  const { renameOrganization, manageOrganization } = useActions(peopleLogic)

  return (
    <div>
      <AccountPageHeader page="people" />
      {offer ? <InvitationOfferBox offer={offer} /> : null}
      {!organization ? (
        peopleLoading ? (
          <Spinner />
        ) : (
          <AccountNotice tone="error">The people on your plan could not be loaded. Reload the page.</AccountNotice>
        )
      ) : (
        <div className="space-y-8">
          {managedOrganizationId ? (
            <AccountNotice tone="info">
              You are managing {organization.owner.name || organization.name}'s plan as an admin.{' '}
              <button type="button" className="underline" onClick={() => manageOrganization(null)}>
                Back to your own
              </button>
            </AccountNotice>
          ) : null}
          <AccountSection title="Name" description="What the people you share frames with see them as coming from.">
            <TextInput
              key={organization.name}
              aria-label="Organization name"
              className="!w-full max-w-sm"
              defaultValue={organization.name}
              maxLength={60}
              disabled={busy !== null || (!isOwner && !managedOrganizationId)}
              onKeyDown={blurOnEnter}
              onBlur={(event) => renameOrganization(event.currentTarget.value)}
            />
          </AccountSection>
          <PeopleSection organization={organization} />
          <ProjectsSection organization={organization} />
          {memberships.length > 0 ? <MembershipsSection memberships={memberships} /> : null}
        </div>
      )}
    </div>
  )
}
