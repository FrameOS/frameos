import { MakeLogicType, actions, afterMount, connect, kea, listeners, path, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'

import { framesModel } from '../../../models/framesModel'
import { apiFetch } from '../../../utils/apiFetch'
import { confirmDialog } from '../../../utils/confirmDialogLogic'
import { showErrorMessage, showSuccessMessage } from '../../../utils/workingMessage'
import { apiCall, describeHttpError, readJsonPayload } from './api'

// The People page (FrameOS Cloud, cloud/docs/sharing.md): the people on the
// account's plan, the projects their frames are shared through, and the
// organizations of other people the account is in. One read
// (GET /api/organization) draws all of it; every change is one call and a
// reload.

export type MemberRole = 'admin' | 'member'

export interface OrganizationMember {
  /** False when the plan has no seat for them: the row stays, the access does not. */
  active: boolean
  email: string | null
  id: string
  joined_at: string
  name: string | null
  role: MemberRole
  you: boolean
}

export interface OrganizationInvitation {
  created_at: string
  email: string
  expires_at: string
  id: string
  project_ids: string[]
  role: MemberRole
}

export interface OrganizationProject {
  frame_ids: string[]
  id: string
  member_ids: string[]
  name: string
}

export interface OrganizationFrame {
  id: string
  name: string
  project_id: string | null
}

export interface Organization {
  /** The owner's frames a project can hold. An admin sees the shared ones only. */
  frames: OrganizationFrame[]
  id: string
  invitations: OrganizationInvitation[]
  members: OrganizationMember[]
  name: string
  owner: { email: string | null; name: string | null; you: boolean }
  /** The plan's people (the owner included) and the seats taken, open invitations too. */
  people: { limit: number; used: number }
  projects: OrganizationProject[]
  /** Who the signed-in account is here. */
  role: 'owner' | 'admin'
}

export interface Membership {
  active: boolean
  joined_at: string
  member_id: string
  organization: { id: string; name: string }
  owner_name: string | null
  projects: { frame_count: number; id: string; name: string }[]
  role: MemberRole
}

export interface PeoplePayload {
  memberships: Membership[]
  organization: Organization | null
}

/** What an invitation link is for, as GET-by-token answers it. */
export interface InvitationOffer {
  already_member: boolean
  email: string
  expires_at: string
  organization: { id: string; name: string }
  own_organization: boolean
  owner_name: string | null
  projects: string[]
  role: MemberRole
  state: 'open' | 'accepted' | 'revoked' | 'expired'
}

export interface InviteDraft {
  email: string
  projectIds: string[]
  role: MemberRole
}

const emptyInvite: InviteDraft = { email: '', projectIds: [], role: 'member' }

/** The `invite` token in the page's address, if the visitor followed a link. */
export function inviteTokenFromLocation(): string | null {
  if (typeof window === 'undefined') {
    return null
  }
  const token = new URLSearchParams(window.location.search).get('invite')
  return token && token.trim() ? token.trim() : null
}

// The link is spent or declined: take it out of the address bar, so a reload
// or a shared screenshot of the URL does not carry it.
function dropInviteFromLocation(): void {
  if (typeof window === 'undefined') {
    return
  }
  const params = new URLSearchParams(window.location.search)
  params.delete('invite')
  const query = params.toString()
  window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash)
}

const errorMessages: Record<string, string> = {
  already_invited: 'That address already has an open invitation.',
  already_member: 'That person is already on your plan.',
  email_failed: 'The invitation could not be sent. Try again in a moment.',
  invalid_email: 'That does not look like an email address.',
  invalid_frame: 'One of those frames cannot be shared from here.',
  invalid_name: 'A name is 1 to 60 characters.',
  invitation_accepted: 'This invitation was already used.',
  invitation_expired: 'This invitation has expired. Ask for a new one.',
  invitation_not_found: 'This invitation link is not valid.',
  invitation_revoked: 'This invitation was taken back. Ask for a new one.',
  organization_not_found: 'You no longer manage that organization.',
  own_organization: 'This invitation is to your own plan.',
  owner_only: 'Only the owner of the plan can do that.',
  people_limit: 'Every seat on the plan is taken. A larger plan has room for more people.',
  session_required: 'Sign in with your password or Google to change this: an API token cannot.',
  too_many_projects: 'That is the most projects a plan can have.',
}

/** A refusal in words: the route's own code where the page knows it. */
export function describePeopleError(status: number, code: string | undefined): string {
  return (code && errorMessages[code]) || describeHttpError(status)
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface peopleLogicValues {
  busy: string | null
  canSendInvite: boolean
  invite: InviteDraft
  inviteLink: {
    email: string
    url: string
  } | null
  isOwner: boolean
  managedOrganizationId: string | null
  memberships: Membership[]
  newProjectName: string
  offer: InvitationOffer | null
  offerLoading: boolean
  organization: Organization | null
  people: PeoplePayload
  peopleLoading: boolean
  seatsLeft: number
  sharingAvailable: boolean
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface peopleLogicActions {
  loadFrames: () => any // framesModel
  acceptOffer: () => {
    value: true
  }
  copyInviteLink: () => {
    value: true
  }
  createProject: () => {
    value: true
  }
  declineOffer: () => {
    value: true
  }
  declineOfferFailure: (
    error: string,
    errorObject?: any
  ) => {
    error: string
    errorObject?: any
  }
  declineOfferSuccess: (
    offer: null,
    payload?: {
      value: true
    }
  ) => {
    offer: null
    payload?: {
      value: true
    }
  }
  deleteProject: (project: OrganizationProject) => {
    project: OrganizationProject
  }
  dismissInviteLink: () => {
    value: true
  }
  inviteSent: (
    email: string,
    url: string
  ) => {
    email: string
    url: string
  }
  leaveOrganization: (membership: Membership) => {
    membership: Membership
  }
  loadOffer: () => any
  loadOfferFailure: (
    error: string,
    errorObject?: any
  ) => {
    error: string
    errorObject?: any
  }
  loadOfferSuccess: (
    offer: InvitationOffer | null,
    payload?: any
  ) => {
    offer: InvitationOffer | null
    payload?: any
  }
  loadPeople: () => any
  loadPeopleFailure: (
    error: string,
    errorObject?: any
  ) => {
    error: string
    errorObject?: any
  }
  loadPeopleSuccess: (
    people: PeoplePayload,
    payload?: any
  ) => {
    people: PeoplePayload
    payload?: any
  }
  manageOrganization: (organizationId: string | null) => {
    organizationId: string | null
  }
  removeMember: (member: OrganizationMember) => {
    member: OrganizationMember
  }
  renameOrganization: (name: string) => {
    name: string
  }
  renameProject: (
    project: OrganizationProject,
    name: string
  ) => {
    name: string
    project: OrganizationProject
  }
  revokeInvitation: (invitation: OrganizationInvitation) => {
    invitation: OrganizationInvitation
  }
  sendInvite: () => {
    value: true
  }
  setBusy: (key: string | null) => {
    key: string | null
  }
  setInvite: (invite: Partial<InviteDraft>) => {
    invite: Partial<InviteDraft>
  }
  setMemberRole: (
    member: OrganizationMember,
    role: MemberRole
  ) => {
    member: OrganizationMember
    role: MemberRole
  }
  setNewProjectName: (name: string) => {
    name: string
  }
  setProjectFrame: (
    project: OrganizationProject,
    frameId: string,
    included: boolean
  ) => {
    frameId: string
    included: boolean
    project: OrganizationProject
  }
  setProjectMember: (
    project: OrganizationProject,
    memberId: string,
    included: boolean
  ) => {
    included: boolean
    memberId: string
    project: OrganizationProject
  }
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface peopleLogicMeta {
  __keaTypeGenInternalSelectorTypes: {
    organization: (people: PeoplePayload) => Organization | null
    memberships: (people: PeoplePayload) => Membership[]
    isOwner: (organization: Organization | null) => boolean
    sharingAvailable: (organization: Organization | null) => boolean
    seatsLeft: (organization: Organization | null) => number
    canSendInvite: (invite: InviteDraft, seatsLeft: number, busy: string | null) => boolean
  }
}

export type peopleLogicType = MakeLogicType<peopleLogicValues, peopleLogicActions, Record<string, any>> &
  peopleLogicMeta

export const peopleLogic = kea<peopleLogicType>([
  path(['src', 'scenes', 'settings', 'account', 'peopleLogic']),
  // The frames list says whose each frame is and which project it is shared
  // through, so it is read again after a change here.
  connect(() => ({ actions: [framesModel, ['loadFrames']] })),
  actions({
    /** Manage another organization (as one of its admins); null is your own. */
    manageOrganization: (organizationId: string | null) => ({ organizationId }),
    setInvite: (invite: Partial<InviteDraft>) => ({ invite }),
    sendInvite: true,
    inviteSent: (email: string, url: string) => ({ email, url }),
    dismissInviteLink: true,
    copyInviteLink: true,
    revokeInvitation: (invitation: OrganizationInvitation) => ({ invitation }),
    setMemberRole: (member: OrganizationMember, role: MemberRole) => ({ member, role }),
    removeMember: (member: OrganizationMember) => ({ member }),
    leaveOrganization: (membership: Membership) => ({ membership }),
    renameOrganization: (name: string) => ({ name }),
    setNewProjectName: (name: string) => ({ name }),
    createProject: true,
    renameProject: (project: OrganizationProject, name: string) => ({ project, name }),
    setProjectFrame: (project: OrganizationProject, frameId: string, included: boolean) => ({
      project,
      frameId,
      included,
    }),
    setProjectMember: (project: OrganizationProject, memberId: string, included: boolean) => ({
      project,
      memberId,
      included,
    }),
    deleteProject: (project: OrganizationProject) => ({ project }),
    acceptOffer: true,
    declineOffer: true,
    /** A change is on its way to the server (`key` names the control). */
    setBusy: (key: string | null) => ({ key }),
  }),
  loaders(({ values }) => ({
    people: [
      { memberships: [], organization: null } as PeoplePayload,
      {
        loadPeople: async () => {
          const query = values.managedOrganizationId
            ? `?organization_id=${encodeURIComponent(values.managedOrganizationId)}`
            : ''
          const response = await apiFetch(`/api/organization${query}`)
          if (!response.ok) {
            throw new Error('Failed to load the people on your plan')
          }
          return (await response.json()) as PeoplePayload
        },
      },
    ],
    offer: [
      null as InvitationOffer | null,
      {
        loadOffer: async () => {
          const token = inviteTokenFromLocation()
          if (!token) {
            return null
          }
          const response = await apiCall('/api/organization/join', 'POST', { token })
          const payload = await readJsonPayload(response)
          if (!response.ok) {
            showErrorMessage(describePeopleError(response.status, payload?.error))
            dropInviteFromLocation()
            return null
          }
          return (payload?.invitation as InvitationOffer | undefined) ?? null
        },
        declineOffer: () => {
          dropInviteFromLocation()
          return null
        },
      },
    ],
  })),
  reducers({
    managedOrganizationId: [
      null as string | null,
      {
        manageOrganization: (_, { organizationId }) => organizationId,
      },
    ],
    invite: [
      emptyInvite,
      {
        setInvite: (state, { invite }) => ({ ...state, ...invite }),
        inviteSent: () => emptyInvite,
        manageOrganization: () => emptyInvite,
      },
    ],
    // The link of the invitation just sent, shown once for the owner to pass
    // on themselves: the server keeps only its hash.
    inviteLink: [
      null as { email: string; url: string } | null,
      {
        inviteSent: (_, { email, url }) => ({ email, url }),
        dismissInviteLink: () => null,
        manageOrganization: () => null,
      },
    ],
    newProjectName: [
      '',
      {
        setNewProjectName: (_, { name }) => name,
        manageOrganization: () => '',
      },
    ],
    busy: [
      null as string | null,
      {
        setBusy: (_, { key }) => key,
      },
    ],
  }),
  selectors({
    organization: [(s) => [s.people], (people: PeoplePayload): Organization | null => people.organization],
    memberships: [(s) => [s.people], (people: PeoplePayload): Membership[] => people.memberships],
    isOwner: [(s) => [s.organization], (organization: Organization | null): boolean => organization?.role === 'owner'],
    /** The plan shares frames at all: more than one person. */
    sharingAvailable: [
      (s) => [s.organization],
      (organization: Organization | null): boolean => (organization?.people.limit ?? 1) > 1,
    ],
    seatsLeft: [
      (s) => [s.organization],
      (organization: Organization | null): number =>
        organization ? Math.max(0, organization.people.limit - organization.people.used) : 0,
    ],
    canSendInvite: [
      (s) => [s.invite, s.seatsLeft, s.busy],
      (invite: InviteDraft, seatsLeft: number, busy: string | null): boolean =>
        invite.email.trim().length > 0 && seatsLeft > 0 && busy === null,
    ],
  }),
  listeners(({ actions, values }) => {
    // One change: the call, the refusal in words, and the page read again so
    // it shows what the server now holds.
    const change = async (
      key: string,
      request: () => Promise<Response>,
      onSuccess?: (payload: Record<string, unknown> | undefined) => void
    ): Promise<boolean> => {
      actions.setBusy(key)
      try {
        const response = await request()
        const payload = await readJsonPayload(response)
        if (!response.ok) {
          showErrorMessage(describePeopleError(response.status, payload?.error))
          return false
        }
        onSuccess?.(payload)
        actions.loadPeople()
        return true
      } finally {
        actions.setBusy(null)
      }
    }
    const scoped = (body: Record<string, unknown>): Record<string, unknown> =>
      values.managedOrganizationId ? { ...body, organization_id: values.managedOrganizationId } : body
    const setProject = (project: OrganizationProject, body: Record<string, unknown>): Promise<boolean> =>
      change(`project:${project.id}`, () =>
        apiCall(`/api/organization/projects/${encodeURIComponent(project.id)}`, 'PATCH', body)
      )

    return {
      manageOrganization: () => {
        actions.loadPeople()
      },
      sendInvite: async () => {
        const { email, projectIds, role } = values.invite
        await change(
          'invite',
          () =>
            apiCall(
              '/api/organization/invitations',
              'POST',
              scoped({ email: email.trim(), project_ids: projectIds, role })
            ),
          (payload) => {
            const url = typeof payload?.url === 'string' ? payload.url : ''
            actions.inviteSent(email.trim(), url)
            showSuccessMessage(`Invitation sent to ${email.trim()}`)
          }
        )
      },
      copyInviteLink: async () => {
        const url = values.inviteLink?.url
        if (!url) {
          return
        }
        try {
          await navigator.clipboard.writeText(url)
          showSuccessMessage('Invitation link copied')
        } catch {
          showErrorMessage('Could not copy the link. Select it and copy it by hand.')
        }
      },
      revokeInvitation: async ({ invitation }) => {
        await change(`invitation:${invitation.id}`, () =>
          apiCall(`/api/organization/invitations/${encodeURIComponent(invitation.id)}`, 'DELETE')
        )
      },
      setMemberRole: async ({ member, role }) => {
        await change(`member:${member.id}`, () =>
          apiCall(`/api/organization/members/${encodeURIComponent(member.id)}`, 'PATCH', { role })
        )
      },
      removeMember: async ({ member }) => {
        const who = member.name || member.email || 'this person'
        const confirmed = await confirmDialog({
          title: `Remove ${who}?`,
          message: 'They lose every frame you share with them, at once. You can invite them again later.',
          confirmLabel: 'Remove',
          danger: true,
        })
        if (!confirmed) {
          return
        }
        await change(`member:${member.id}`, () =>
          apiCall(`/api/organization/members/${encodeURIComponent(member.id)}`, 'DELETE')
        )
      },
      leaveOrganization: async ({ membership }) => {
        const confirmed = await confirmDialog({
          title: `Stop sharing frames with ${membership.organization.name}?`,
          message: 'Their frames leave your workspace at once. They can invite you again later.',
          confirmLabel: 'Leave',
          danger: true,
        })
        if (!confirmed) {
          return
        }
        const left = await change(`membership:${membership.member_id}`, () =>
          apiCall(`/api/organization/members/${encodeURIComponent(membership.member_id)}`, 'DELETE')
        )
        if (left) {
          // The organization being managed may be the one just left.
          if (values.managedOrganizationId === membership.organization.id) {
            actions.manageOrganization(null)
          }
          actions.loadFrames()
        }
      },
      renameOrganization: async ({ name }) => {
        const trimmed = name.trim()
        if (!trimmed || trimmed === values.organization?.name) {
          return
        }
        await change('organization', () => apiCall('/api/organization', 'PATCH', scoped({ name: trimmed })))
      },
      createProject: async () => {
        const name = values.newProjectName.trim()
        if (!name) {
          return
        }
        await change(
          'new-project',
          () => apiCall('/api/organization/projects', 'POST', scoped({ name })),
          () => actions.setNewProjectName('')
        )
      },
      renameProject: async ({ project, name }) => {
        const trimmed = name.trim()
        if (!trimmed || trimmed === project.name) {
          return
        }
        await setProject(project, { name: trimmed })
      },
      setProjectFrame: async ({ project, frameId, included }) => {
        const frameIds = included
          ? [...new Set([...project.frame_ids, frameId])]
          : project.frame_ids.filter((id) => id !== frameId)
        if (await setProject(project, { frame_ids: frameIds })) {
          // The frames list says which project each frame is shared through.
          actions.loadFrames()
        }
      },
      setProjectMember: async ({ project, memberId, included }) => {
        const memberIds = included
          ? [...new Set([...project.member_ids, memberId])]
          : project.member_ids.filter((id) => id !== memberId)
        await setProject(project, { member_ids: memberIds })
      },
      deleteProject: async ({ project }) => {
        const confirmed = await confirmDialog({
          title: `Delete the project "${project.name}"?`,
          message:
            project.frame_ids.length > 0
              ? 'Its frames stay yours and stop being shared with anyone.'
              : 'Nothing is shared through it yet.',
          confirmLabel: 'Delete project',
          danger: true,
        })
        if (!confirmed) {
          return
        }
        if (
          await change(`project:${project.id}`, () =>
            apiCall(`/api/organization/projects/${encodeURIComponent(project.id)}`, 'DELETE')
          )
        ) {
          actions.loadFrames()
        }
      },
      acceptOffer: async () => {
        const token = inviteTokenFromLocation()
        const offer = values.offer
        if (!token || !offer) {
          return
        }
        const joined = await change('offer', () => apiCall('/api/organization/join', 'POST', { accept: true, token }))
        if (joined) {
          showSuccessMessage(`You now share frames with ${offer.owner_name ?? offer.organization.name}`)
          actions.loadFrames()
        }
        // Spent either way: a refusal said why, and trying the same link
        // again would say it again.
        actions.declineOffer()
      },
    }
  }),
  afterMount(({ actions }) => {
    actions.loadPeople()
    actions.loadOffer()
  }),
])
