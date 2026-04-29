export function run(app: FrameOSApp): void {
  frameos.setNextSleep(app.config.duration)
  app.log(`Next sleep set to ${app.config.duration} seconds`)
}
