# Ignore missing kernel modules in the initrd closure (useful on Pi boards)
_: prev: {
  makeModulesClosure = x: prev.makeModulesClosure (x // { allowMissing = true; });
}
