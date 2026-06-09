declare module '@frameos-cloud/auth-client' {
  export type FrameosAuthProviderConfig =
    | {
        disabled: true
        providerUrl?: undefined
      }
    | {
        disabled: false
        providerUrl: string
      }

  export function normalizeFrameosAuthProviderUrl(
    value: string | null | undefined,
    defaultProviderUrl?: string
  ): FrameosAuthProviderConfig
}
