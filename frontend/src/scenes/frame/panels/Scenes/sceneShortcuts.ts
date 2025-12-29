import { FrameScene } from '../../../../types'

const baseSdCardImageScene: FrameScene = {
  id: '6c7a6328-bb39-452a-bd3e-e9902b3925f4',
  name: 'SD card image',
  settings: {
    backgroundColor: '#000000',
    refreshInterval: 60,
    execution: 'interpreted',
  },
  fields: [
    {
      access: 'public',
      label: 'Image folder',
      name: 'imageFolder',
      persist: 'disk',
      type: 'string',
      value: '/srv/assets',
    },
    {
      access: 'public',
      label: 'Image order',
      name: 'imageOrder',
      options: ['random', 'alphabetical'],
      persist: 'disk',
      type: 'select',
      value: 'random',
    },
    {
      access: 'public',
      label: 'Seconds to show one image',
      name: 'seconds',
      persist: 'disk',
      type: 'float',
      value: '900',
    },
    {
      access: 'public',
      label: 'Scaling mode',
      name: 'scalingMode',
      options: ['cover', 'contain', 'stretch', 'center'],
      persist: 'disk',
      type: 'select',
      value: 'cover',
    },
    {
      access: 'private',
      label: 'counter',
      name: 'counter',
      persist: 'disk',
      type: 'integer',
      value: '0',
    },
    {
      name: 'search',
      label: 'Search in filename',
      type: 'string',
      persist: 'disk',
      access: 'public',
    },
  ],
  nodes: [
    {
      data: {
        keyword: 'render',
      },
      dragging: false,
      height: 168,
      id: '463556ab-e4fe-40c7-93f3-40bc723f454e',
      position: {
        x: -324.87674385581977,
        y: 105.2893987040016,
      },
      positionAbsolute: {
        x: -324.87674385581977,
        y: 105.2893987040016,
      },
      selected: false,
      type: 'event',
      width: 212,
    },
    {
      data: {
        config: {},
        keyword: 'render/image',
      },
      dragging: false,
      height: 130,
      id: 'e7cb0eec-b9db-48d5-8f19-21e443783833',
      position: {
        x: 238,
        y: 140,
      },
      positionAbsolute: {
        x: 238,
        y: 140,
      },
      resizing: false,
      selected: false,
      style: {
        height: 130,
        width: 238,
      },
      type: 'app',
      width: 238,
    },
    {
      data: {
        cache: {
          duration: 'state{"seconds"}.getFloat()',
          durationEnabled: false,
          enabled: false,
          expression: 'state{"seconds"}.getFloat()',
          expressionEnabled: false,
          inputEnabled: false,
        },
        config: {
          counterStateKey: 'counter',
        },
        keyword: 'data/localImage',
      },
      dragging: false,
      height: 196,
      id: '90e0b322-3302-4b36-ae37-70c71183d722',
      position: {
        x: 144.60458833601461,
        y: -172.2349676000406,
      },
      positionAbsolute: {
        x: 144.60458833601461,
        y: -172.2349676000406,
      },
      selected: false,
      type: 'app',
      width: 489,
    },
    {
      data: {
        config: {},
        keyword: 'logic/nextSleepDuration',
      },
      dragging: false,
      height: 78,
      id: '86d00a0b-0d58-4e06-b345-f662b4796ec3',
      position: {
        x: 710.2916548468124,
        y: 143.69341505862138,
      },
      positionAbsolute: {
        x: 710.2916548468124,
        y: 143.69341505862138,
      },
      selected: false,
      type: 'app',
      width: 289,
    },
    {
      id: '936017dc-922d-43f3-aab7-7ba996afd83d',
      position: {
        x: 206.81766899824183,
        y: 50.686622074619635,
      },
      data: {
        keyword: 'scalingMode',
      },
      type: 'state',
      width: 218,
      height: 48,
      selected: false,
      positionAbsolute: {
        x: 206.81766899824183,
        y: 50.686622074619635,
      },
      dragging: false,
    },
    {
      id: '3ea1c753-d7b8-43dd-a3d3-74df6c80066b',
      position: {
        x: 111.41792894140457,
        y: -246.0792395842769,
      },
      data: {
        keyword: 'imageFolder',
      },
      type: 'state',
      width: 211,
      height: 48,
      selected: false,
      positionAbsolute: {
        x: 111.41792894140457,
        y: -246.0792395842769,
      },
      dragging: false,
    },
    {
      id: 'b286d5fa-f93a-4616-ba8d-4936fa3d407e',
      position: {
        x: 75.57758829702689,
        y: -317.72334906343747,
      },
      data: {
        keyword: 'imageOrder',
      },
      type: 'state',
      width: 206,
      height: 48,
      selected: false,
      positionAbsolute: {
        x: 75.57758829702689,
        y: -317.72334906343747,
      },
      dragging: false,
    },
    {
      id: 'ddc4be08-1995-48d3-881b-81fb0d78bf68',
      position: {
        x: 671.632792959911,
        y: 66.25911461494695,
      },
      data: {
        keyword: 'seconds',
      },
      type: 'state',
      width: 343,
      height: 48,
      selected: false,
      positionAbsolute: {
        x: 671.632792959911,
        y: 66.25911461494695,
      },
      dragging: false,
    },
    {
      id: 'c2cd62ad-1fac-4479-92e2-2c2c78c45a81',
      position: {
        x: 28.40799267471894,
        y: -384.8400124630144,
      },
      data: {
        keyword: 'search',
      },
      type: 'state',
      width: 154,
      height: 48,
      selected: false,
      positionAbsolute: {
        x: 28.40799267471894,
        y: -384.8400124630144,
      },
      dragging: false,
    },
    {
      id: 'd1cae7f2-ee6b-4412-966d-a5c14ef075f8',
      type: 'event',
      position: {
        x: 493.70033730390446,
        y: -347.23122141940934,
      },
      data: {
        keyword: 'button',
      },
      width: 201,
      height: 40,
      selected: false,
      positionAbsolute: {
        x: 493.70033730390446,
        y: -347.23122141940934,
      },
      dragging: false,
    },
    {
      id: 'fd229865-6d11-4a7a-b8d1-b4167e27a29b',
      type: 'dispatch',
      position: {
        x: 743.4481265196674,
        y: -347.23122141940945,
      },
      data: {
        keyword: 'render',
        config: {},
      },
      width: 260,
      height: 40,
      selected: false,
      positionAbsolute: {
        x: 743.4481265196674,
        y: -347.23122141940945,
      },
      dragging: false,
    },
  ],
  edges: [
    {
      id: '6fd73ac5-deba-46ce-98ae-6781962b6922',
      source: '463556ab-e4fe-40c7-93f3-40bc723f454e',
      sourceHandle: 'next',
      target: 'e7cb0eec-b9db-48d5-8f19-21e443783833',
      targetHandle: 'prev',
      type: 'appNodeEdge',
    },
    {
      id: '844f8206-5414-4959-b76b-feec2af647d4',
      source: '90e0b322-3302-4b36-ae37-70c71183d722',
      sourceHandle: 'fieldOutput',
      target: 'e7cb0eec-b9db-48d5-8f19-21e443783833',
      targetHandle: 'fieldInput/image',
      type: 'codeNodeEdge',
    },
    {
      id: 'c7217229-bdbd-47ed-af35-08b459159d7f',
      source: 'e7cb0eec-b9db-48d5-8f19-21e443783833',
      sourceHandle: 'next',
      target: '86d00a0b-0d58-4e06-b345-f662b4796ec3',
      targetHandle: 'prev',
      type: 'appNodeEdge',
    },
    {
      id: '3d82d080-28c2-418f-9ae8-668a6c8155ee',
      target: 'e7cb0eec-b9db-48d5-8f19-21e443783833',
      targetHandle: 'fieldInput/placement',
      source: '936017dc-922d-43f3-aab7-7ba996afd83d',
      sourceHandle: 'fieldOutput',
      type: 'codeNodeEdge',
    },
    {
      id: '52db19f4-ccf1-4a10-bbf1-0a7a5a440b42',
      target: '90e0b322-3302-4b36-ae37-70c71183d722',
      targetHandle: 'fieldInput/path',
      source: '3ea1c753-d7b8-43dd-a3d3-74df6c80066b',
      sourceHandle: 'fieldOutput',
      type: 'codeNodeEdge',
    },
    {
      id: 'db942c13-4a92-4939-a710-7ca38dceb80d',
      target: '90e0b322-3302-4b36-ae37-70c71183d722',
      targetHandle: 'fieldInput/order',
      source: 'b286d5fa-f93a-4616-ba8d-4936fa3d407e',
      sourceHandle: 'fieldOutput',
      type: 'codeNodeEdge',
    },
    {
      id: '3505a1c7-8965-44e2-8394-b43d76e40dc2',
      target: '86d00a0b-0d58-4e06-b345-f662b4796ec3',
      targetHandle: 'fieldInput/duration',
      source: 'ddc4be08-1995-48d3-881b-81fb0d78bf68',
      sourceHandle: 'fieldOutput',
      type: 'codeNodeEdge',
    },
    {
      id: 'f3af9756-8603-48aa-b247-486bff2060c2',
      source: 'c2cd62ad-1fac-4479-92e2-2c2c78c45a81',
      sourceHandle: 'fieldOutput',
      target: '90e0b322-3302-4b36-ae37-70c71183d722',
      targetHandle: 'fieldInput/search',
      type: 'codeNodeEdge',
    },
    {
      id: '2d6987e3-b914-45bb-9493-74a657688fe5',
      source: 'd1cae7f2-ee6b-4412-966d-a5c14ef075f8',
      sourceHandle: 'next',
      target: 'fd229865-6d11-4a7a-b8d1-b4167e27a29b',
      targetHandle: 'prev',
      type: 'appNodeEdge',
    },
  ],
}

export function buildSdCardImageScene(imageFilename: string, assetsPath: string, sceneId: string): FrameScene {
  const normalizedAssetsPath = assetsPath.replace(/\/+$/, '') || '/srv/assets'
  const uploadFolder = `${normalizedAssetsPath}/uploads`
  const safeFilename = imageFilename || 'image'

  return {
    ...baseSdCardImageScene,
    id: sceneId,
    fields: baseSdCardImageScene.fields?.map((field) => {
      if (field.name === 'imageFolder') {
        return { ...field, value: uploadFolder }
      }
      if (field.name === 'search') {
        return { ...field, value: safeFilename }
      }
      return field
    }),
  }
}

export function buildLocalImageScene(imageFilename: string, imageFolder: string, sceneId: string): FrameScene {
  const normalizedFolder = imageFolder.replace(/\/+$/, '') || '/srv/assets'
  const safeFilename = imageFilename || 'image'

  return {
    ...baseSdCardImageScene,
    id: sceneId,
    fields: baseSdCardImageScene.fields?.map((field) => {
      if (field.name === 'imageFolder') {
        return { ...field, value: normalizedFolder }
      }
      if (field.name === 'search') {
        return { ...field, value: safeFilename }
      }
      return field
    }),
  }
}

export function buildLocalImageFolderScene(imageFolder: string, sceneId: string): FrameScene {
  const normalizedFolder = imageFolder.replace(/\/+$/, '') || '/srv/assets'

  return {
    ...baseSdCardImageScene,
    id: sceneId,
    fields: baseSdCardImageScene.fields?.map((field) => {
      if (field.name === 'imageFolder') {
        return { ...field, value: normalizedFolder }
      }
      if (field.name === 'search') {
        return { ...field, value: '' }
      }
      return field
    }),
  }
}
