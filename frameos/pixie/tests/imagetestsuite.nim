import algorithm, os, osproc, strformat, strutils
import pixie/common, pixie/fileformats/gif, pixie/fileformats/jpeg,
  pixie/fileformats/png, pixie/fileformats/tiff

when defined(writeImages):
  import write_images

const imageTestSuitePath = "../imagetestsuite"

type
  Expectation = enum
    shouldDecode
    shouldReject
    shouldNotCrash

  RunStatus = enum
    decoded
    rejected
    failed

  RunResult = object
    status: RunStatus
    message: string

  TestStats = object
    total, passed: int
    failures: seq[string]

const gifExpectations = [
  # Based on the upstream GIFTestSuite notes. Most files are malformed on
  # purpose and should be rejected cleanly instead of decoded.
  ("0646caeb9b9161c777f117007921a687.gif", shouldReject),
  ("243d9798466d64aba0acaa41f980bea6.gif", shouldReject),
  ("2b5bc31d84703bfb9f371925f0e3e57d.gif", shouldReject),
  ("55abb3cc464305dd554171c3d44cb61f.gif", shouldReject),
  ("5f09a896c191db3fa7ea6bdd5ebe9485.gif", shouldReject),
  ("6d939393058de0579fca1bbf10ecff25.gif", shouldReject),
  ("7092f253998c1b6b869707ad7ae92854.gif", shouldReject),
  ("9f8f6046eaf9ffa2d9c5d6db05c5f881.gif", shouldReject),
  ("adaf0da1764aafb7039440dbe098569b.gif", shouldReject),
  ("adf6f850b13dff73ebb22862c6ab028b.gif", shouldReject),
  ("bc7af0616c4ae99144c8600e7b39beea.gif", shouldReject),
  ("ce774930ac70449f38a18789c70095b8.gif", shouldReject),
  ("d5a0175c07418852152ef33a886a5029.gif", shouldReject),
  ("e34116d68f49c7852b362ec72a636df5.gif", shouldReject),
  ("e6aa0c45a13dd7fc94f7b5451bd89bf4.gif", shouldDecode),
  ("ea754e040929b7f9c157efc88c4d0eaf.gif", shouldReject),
  ("ee6d1133f9264dc6467990e53d0bf104.gif", shouldReject),
  # Pixie intentionally tolerates this extension-order issue.
  ("f617c7af7f36296a37ddb419b828099c.gif", shouldDecode),
  ("f88b6907ee086c4c8ac4b8c395748c49.gif", shouldReject),
  ("fc3e2b992c559055267e26dc23e484c0.gif", shouldReject)
]

const jpgExpectations = [
  # Curated against ImageMagick and Pixie's supported JPEG subset. Files Pixie
  # should fully decode are shouldDecode, decodable-but-unsupported variants are
  # shouldNotCrash, and malformed files that should still be rejected are
  # shouldReject.
  ("138d3b9e0d9fbf641b8135981e597c3a.jpg", shouldNotCrash),
  ("194531363df5b73f59c4c0517422f917.jpg", shouldDecode),
  ("1cbb1bb37d62c44f67374cd451643dc4.jpg", shouldNotCrash),
  ("2183d39878e734cf79b62428b02fafb5.jpg", shouldReject),
  ("21a84b8472f6d18f5bb5c0026e97cfaa.jpg", shouldReject),
  ("21ad703b38e2c350215bb92a849486f3.jpg", shouldDecode),
  ("255015e07b6f9137b53b0f97d67a8aef.jpg", shouldDecode),
  ("28968137f4fc75fbf56f16d7a7a8551a.jpg", shouldReject),
  ("28c74d9284d9836017fd519f6932efd8.jpg", shouldDecode),
  ("2c9e7a1805f8b47630bbb83d21bf8222.jpg", shouldDecode),
  ("316be81dfdeeb942e904feb3a77f4f83.jpg", shouldDecode),
  ("32d08f4a5eb10332506ebedbb9bc7257.jpg", shouldDecode),
  ("3976a754ef0aca80e84e2c403d714579.jpg", shouldDecode),
  ("39f43f280b31152f1d27df3f9d189317.jpg", shouldNotCrash),
  ("3ba6af611cc5467cfdbd5566561b8478.jpg", shouldReject),
  ("3cc4a7fc6481ea3681138da4643f3d16.jpg", shouldNotCrash),
  ("3ea649db8e81a46ca4f92fb3238f78ff.jpg", shouldDecode),
  ("3ef05501315073d9d4e1c6b654d99ac0.jpg", shouldNotCrash),
  ("4085c929e00c446d3fee18b5b20a27f9.jpg", shouldReject),
  ("40bb78b1ac031125a6d8466b374962a8.jpg", shouldDecode),
  ("46e5ac4a62d7a445a7c1fb704fafe05c.jpg", shouldReject),
  ("46f5d9c1b0fe352353688f736e5617b6.jpg", shouldDecode),
  ("4838ece0d3900220d33528ee027289bc.jpg", shouldDecode),
  ("5315c35bbcc28d8eee419028ac9f38e0.jpg", shouldDecode),
  ("5482a54657765056f1a94116a8dbffe7.jpg", shouldNotCrash),
  ("551c2656a4f6f9f5ea7e9945b9081202.jpg", shouldDecode),
  ("5633ed9d0eb700d0093bf85d86a95ebf.jpg", shouldReject),
  ("56d4a1bb53241f7c5ed6ab531320a542.jpg", shouldDecode),
  ("59d3b529c78ac722127c41ba75b3355b.jpg", shouldDecode),
  ("5a43fa2cf9c1e47f0331ef71b928ee55.jpg", shouldReject),
  ("5baad44ca4702949724234e35c5bb341.jpg", shouldDecode),
  ("5bc61724b33e34a6188a817f9f2f8138.jpg", shouldDecode),
  ("5c67195f6993c9f8d0d32d4ffe0d8e62.jpg", shouldDecode),
  ("5dc71b1d868ef137394d3cc23abea65a.jpg", shouldReject),
  ("627c0779eb46b98f751187c5c9f43aa3.jpg", shouldReject),
  ("6903d4538fd33c8fd0ded32cb30d618e.jpg", shouldReject),
  ("6de166ee2a3a60df9017650e2a808408.jpg", shouldReject),
  ("72d091e08c93c9e590360130fa35221b.jpg", shouldDecode),
  ("754664a12e36abff7950e796c906ae39.jpg", shouldReject),
  ("75e4bd7544a85af6438497980b62fba5.jpg", shouldDecode),
  ("786b67badc535fc95a4a76c29a0e0146.jpg", shouldDecode),
  ("7997b6b229f25315d33f5c7085e37500.jpg", shouldDecode),
  ("79f5fc6bca756e1f067c6fc83e18b32e.jpg", shouldDecode),
  ("7acc832f70b2ca62e58a953f3b90fd82.jpg", shouldReject),
  ("7dbf474f80e466e9e25ee46b84166420.jpg", shouldDecode),
  ("7e7cdf7f4ee50b308531313bbf43e0c3.jpg", shouldReject),
  ("8417a305e3b43d5b1bda4ff06a660c54.jpg", shouldReject),
  ("8546907dbe574744d7fea6ca9de1de6b.jpg", shouldDecode),
  ("865db3dd2d380626f16b6f9dc6d62dba.jpg", shouldDecode),
  ("897b8b6d8feb466aa6cad5f512c3fce2.jpg", shouldReject),
  ("8a9cc8eeed66aeb423a91c44111d9450.jpg", shouldDecode),
  ("8e330afbd99ba01b66570ed62fcdc6ab.jpg", shouldReject),
  ("8e5e74dbf9b68a322fbb9512db837329.jpg", shouldDecode),
  ("90e46387f562ca8fa106b51dfcda1dc6.jpg", shouldReject),
  ("96b3e939852157613fa2e48d58fe35fe.jpg", shouldDecode),
  ("9efd60f04cd971daa83d3131e6d6f389.jpg", shouldDecode),
  ("a17806f32b45d63eea5230e7893e1f15.jpg", shouldDecode),
  ("a54f8c866cbef6e6cda858c85d72dfc8.jpg", shouldReject),
  ("a7326ba8f3f4559991126474dd30083d.jpg", shouldNotCrash),
  ("acb1fac4e618f636d415f62496e8b70e.jpg", shouldDecode),
  ("acce3629083f0e348e94fb58f952d3de.jpg", shouldReject),
  ("adcb34b94f4c839bdd29037419a0ee53.jpg", shouldReject),
  ("b0b8914cc5f7a6eff409f16d8cc236c5.jpg", shouldReject),
  ("b4103df93880fc5677c2a081e4bfc712.jpg", shouldDecode),
  ("b5369bcbddca7135a5708c5237ad64e4.jpg", shouldDecode),
  ("b55977028a3a574336966b6536640fc9.jpg", shouldDecode),
  ("ba60305ac83fe3d8ef01da1d9a0ecc79.jpg", shouldDecode),
  ("bd8cf05698aee36b82b4caf58edea442.jpg", shouldReject),
  ("c1ca5583e4bfadc73e7fe9418b6e6bf4.jpg", shouldReject),
  ("c3018ebe53d0046eecb58858ca869a99.jpg", shouldDecode),
  ("c4ced510f44a9bfe85c696c05a7f791d.jpg", shouldReject),
  ("c52ffdd6a0346c4d09271f8ccbdfd5a3.jpg", shouldReject),
  ("c8bc97335529d069a753c67475b8c82c.jpg", shouldReject),
  ("c8c1a5675f82021d92b928a10c597bad.jpg", shouldReject),
  ("cc23dd79637b606cf5ba234a037e17ba.jpg", shouldReject),
  ("cc4ee796d16c9fe68978166c7cd1ae1b.jpg", shouldReject),
  ("ce380515a534e8226209daae00e7b4e8.jpg", shouldReject),
  ("d085a42245996e5750a30ccb48791bcf.jpg", shouldReject),
  ("d15b71b8cebe35a57cc6e996cc09218b.jpg", shouldDecode),
  ("d22db5be7594c17a18a047ca9264ea0a.jpg", shouldDecode),
  ("d3b044a94486cae0224c002800ddd642.jpg", shouldReject),
  ("de4ae285a275bcfe2ac87c0126742552.jpg", shouldReject),
  ("de5884cec093257d239f3b8be3e2f2e5.jpg", shouldDecode),
  ("e18bb52107598f65b81b02be2c6c5124.jpg", shouldReject),
  ("e6d9eca2c7405e13cfb850b7d0ef7476.jpg", shouldReject),
  ("eddea4ef9629be031f750a8ff0b7497c.jpg", shouldReject),
  ("eecb78b937a7c5f04aae2f5b0f5b5acc.jpg", shouldDecode),
  ("ef1f8a057bb6056674fad92f6b8c0acd.jpg", shouldNotCrash),
  ("ef724193653930f52acffa90e6426fd2.jpg", shouldReject),
  ("f006e96f3b27fdfaa075322d759ea2e8.jpg", shouldDecode),
  ("f012a4321f00f12af6b1eee7580ffb9c.jpg", shouldReject),
  ("f1fad47f213bb64c99f714652f30e49e.jpg", shouldReject),
  ("f6419b06a39ff09604343848658b1a41.jpg", shouldDecode),
  ("f6b4389c3cf0f5997b2e5a4b905aea8d.jpg", shouldDecode),
  ("f6d3f522dcb693d9e731d5a0fb4e1393.jpg", shouldDecode),
  ("f8e19feecd246156b5d7e79efc455e99.jpg", shouldReject),
  ("fd44dc63fa7bdd12ee34fc602231ef02.jpg", shouldDecode),
  ("fddcfc778ada60229380c2493fc4c243.jpg", shouldReject)
]

const pngExpectedFileCount = 254

# Based on the upstream PNGTestSuite notes and cross-checked with ImageMagick.
# Files listed in pngShouldDecode are valid PNGs in Pixie's supported subset.
# Files listed in pngShouldNotCrash are malformed files ImageMagick still
# decodes/identifies. Every other PNG in the current suite should reject.
const pngShouldDecode = """
0839d93f8e77e21acd0ac40a80b14b7b.png
1ebd73c1d3fbc89782f29507364128fc.png
2d641a11233385bb37a524ff010a8531.png
66ac49ef3f48ac9482049e1ab57a53e9.png
affc57dfffa5ec448a0795738d456018.png
b59d7a023a8dcd112da2eb859004199a.png
ba2b2b6e72ca0e4683bb640e2d5572f8.png
c636287a4d7cb1a36362f7f236564cef.png
c-m1-66ac49ef3f48ac9482049e1ab57a53e9.png
c-m1-e0f25ec3373dfdca79ba7bcc3ad366f3.png
c-m3-66ac49ef3f48ac9482049e1ab57a53e9.png
c-m4-6bfb149151f58d124d6fa76eaad75520.png
d2e515cfdabae699301dcf290382474d.png
ebfb1cd42314a557e72d4da75c21fc1c.png
18f9baf3834980f4b80a3e82ad45be48.png
51a4d21670dc8dfa8ffc9e54afd62f5f.png
6c853ed9dacd5716bc54eb59cec30889.png
93e6127b9c4e7a99459c558b81d31bc5.png
ac6343a98f8edabfcc6e536dd75aacb0.png
e59ec0cfb8ab64558099543dc19f8378.png
"""

const pngShouldNotCrash = """
# Malformed PNGs that ImageMagick still decodes or identifies.
008b8bb75b8a487dc5aac86c9abb06fb.png
0132cfdbd8ca323574a2072e7ed5014c.png
0301fde58080883e938b604cab9768ea.png
073c98872b81d1004d750f18a4b5f732.png
0b7d50ac449fd59eb3de00647636d0c9.png
0d466db9067b719df0b06ef441bf1ee7.png
138331052d7c6e4acebfaa92af314e12.png
13f665c09e4b03cdbe2fff3015ec8aa7.png
18bd8bf75e7a9b40b961dd501654ce0e.png
1ae14e57b7062597279134ff2eeb39c0.png
1b9a48cf04466108f6f2d225d100edbf.png
1bcc34d49e56a2fba38490db206328b8.png
2a6ff5f8106894b22dad3ce99673481a.png
31e3bc3eb811cff582b5feee2494fed8.png
429104334d1fb6a58e17307883c17608.png
42ec8668adb5dbc6581393f463976510.png
4389427591c18bf36e748172640862c3.png
4c5b82ba0a9c12356007bd71e52185b2.png
4f14b7aab3a41855378c5517342598b9.png
579294d4d8110fc64980dd72a5066780.png
5b689479bd7e527c2385a40437272607.png
5beaadc10dfdbf61124e98fdf8a5c191.png
5e2b64196b9e014e0ed0a27873cafdb3.png
611b294df9cf794eeaa1ffcc620bf6a4.png
6399623892b45aa4901aa6e702c7a62d.png
64221ffc9050c92b8980326acc0e4194.png
71714b783e01aec455b5a4a760326ccc.png
7b9abb94ace0278f943a6df29d0ca652.png
829b05b759b2977bc3eb970ab256d867.png
8711007ea5e351755a80cba913d16a32.png
8905ba870cd5d3327a8310fa437aa076.png
9540743374e1fdb273b6a6ca625eb7a3.png
9bd8a9ed81c5a9190f74496197da7249.png
a1d54c960686558901e320a52a967158.png
a24a39e69554a701412b3ed0c009e7f6.png
b3ac9fdb7239f42c734921dfe790291b.png
bf203e765c98b12f6c2b2c33577c730d.png
c0a76d267196727887d45de4889bec33.png
c1a4baf5d7c68d366d4d4f948f7295be.png
c5c030bf52b9b2d8c45c88988fafff4f.png
c-5e2b64196b9e014e0ed0a27873cafdb3.png
d45b0dbbb808df6486f8a13ea44ea174.png
d92428f3fc9c806b0a4373b54e06785e.png
dd18aac055d531e0e4ff8979458dbaa3.png
e76546768d4a8f2f4c39339345c7614c.png
ed5f2464fcaadd4e0a5e905e3ac41ad5.png
edf5c1b0aa5b01eea5017290a286a173.png
f6266c0e9c2f7db9fab0f84562f63b6c.png
f757de9794666c3d14985210679bc98c.png
fa9f6aa9bcc679d20e171dbf07a628fd.png
m1-66ac49ef3f48ac9482049e1ab57a53e9.png
m1-e0f25ec3373dfdca79ba7bcc3ad366f3.png
m3-66ac49ef3f48ac9482049e1ab57a53e9.png
"""

const tiffExpectedFileCount = 166

# Based on the upstream TIFFTestSuite notes and cross-checked with ImageMagick.
# Files listed in tiffShouldDecode are currently decoded by Pixie. Files listed
# in tiffShouldNotCrash are identified by ImageMagick but still outside Pixie's
# supported TIFF subset.
const tiffShouldDecode = """
0c84d07e1b22b76f24cccc70d8788e4a.tif
551adc8ce6c3c9cc59040903b0428f47.tif
7324fcaff3aad96f27899da51c1bb5d9.tif
8d8582b004aa2560f5bccffbccf4f3d6.tif
e45931b568d12c9905b1db1775321972.tif
f505d8aaa96b8da1a1c92363b898f97a.tif
m2-108af7a96a2efa82a0cee0f200e6b9a2.tif
"""

const tiffShouldNotCrash = """
023c970a2a16794f9e51101f76d3bf4d.tif
034ed0549f9046b9c370ac26550a60da.tif
0ceffbda821c7564352b313bed43f7c7.tif
16f2a7e9adcda96170bc1fa873e275c1.tif
1af8e95246f4cfa4e5e58f67d6428ea3.tif
221209eb0a273029efa18f4c61f6628a.tif
27d40bc5f25d8382b890766accb28cf7.tif
2b27b742e68d313d5ea4abd7847cbff4.tif
356a619433db27fb412ec6fef583eded.tif
362323f81c0160afd677241cd5ce92e9.tif
401d27e0565674c24a017588b8cd61d2.tif
434cb1e9680e3b4eda7f4dd430bcd2bf.tif
48af30b09e42ec73f206ce1ac09a424b.tif
54743a2a36ef90c7ed8bb5da8b6ebaf4.tif
5dd2583cd54384e56a769f04ea05c999.tif
6453732434a8a2358a3c895d962bdce2.tif
84399cc32c29ac0cf33b96a0f654f379.tif
89b5888641d5910e92bf451b5e639ad0.tif
9b286add70871bbbef1601997b429344.tif
9bd49db0707bb5d7ddeca56b1de28ab8.tif
a516905c06cbc05e8adac7b0b7e4f514.tif
b05937c07e0f3ce1bfd2c8c71b0220ec.tif
b1247c37897d354610a07ddfe17eb669.tif
b52a2fceb34f9b31cb417379cf8c02ba.tif
b9bc00e0fb28f2a525c0acfe78251eda.tif
c0d253443d8d4241035fff993ea0581b.tif
c16f4894de3142b98e8f3d8fc6b3d23e.tif
ccd82bb72407d0ca03cac50eb42faf47.tif
ce50e53224a3b62bb821bc294bf6a588.tif
d664a73588796b59191ad8628065f04a.tif
e00804b3169008f1c00bf250edccdae4.tif
ebad222e9402d00e371c92ab5da86e6b.tif
ecf22eaecaf11fc75938973745138868.tif
efb780f70a7d94fa98adfc98d2aa8d50.tif
f15fca5bfdef640840d8ea30570c8cea.tif
f4bcc246f3471102a2dea2ee9153b372.tif
f8179f8f5e566349cf3583a1ff3ea95c.tif
fa0aa927763ee4c7ebf43a5d05dfebc7.tif
m10-42c19f8e79e582bef107f372f18a074b.tif
m11-42c19f8e79e582bef107f372f18a074b.tif
m12-42c19f8e79e582bef107f372f18a074b.tif
m1-62804e47400d6a0fd233c32ea8db4e48.tif
m1-68bc8a1966db7a1da2d3b5946c00d1af.tif
m17-42c19f8e79e582bef107f372f18a074b.tif
m1-76d5d8fd02d58b774f2bae6f7b763e3e.tif
m18-42c19f8e79e582bef107f372f18a074b.tif
m1-84da94dc7e5469f7849b0a7efdff5462.tif
m1-93456679a773921d30efafd08f3ad542.tif
m1-96292a1bd64fec83bb6cdd2480a755b6.tif
m1-b0d36ed02fc2624ac79d3144e8b1bda2.tif
m1-b127f0fb89daedea07abb50b9db2dfd9.tif
m1-d0f86ab189cbe900ec389ca6d7464713.tif
m1-f0d7bcb90496c323c880a9773dfe93ff.tif
m1-f228b1103fd7b629c08c1bbba94708e0.tif
m1-f4830e8d4fa458f78a09fcaaf260569c.tif
m2-b0d36ed02fc2624ac79d3144e8b1bda2.tif
m2-b1ab6f4b81e9b8020a90c8f2c9bcfedb.tif
m2-f0d7bcb90496c323c880a9773dfe93ff.tif
m2-f228b1103fd7b629c08c1bbba94708e0.tif
m2-f4830e8d4fa458f78a09fcaaf260569c.tif
m3-76d5d8fd02d58b774f2bae6f7b763e3e.tif
m3-f0d7bcb90496c323c880a9773dfe93ff.tif
m4-d0f86ab189cbe900ec389ca6d7464713.tif
m5-f0d7bcb90496c323c880a9773dfe93ff.tif
m6-f0d7bcb90496c323c880a9773dfe93ff.tif
m7-42c19f8e79e582bef107f372f18a074b.tif
m7-f0d7bcb90496c323c880a9773dfe93ff.tif
m8-42c19f8e79e582bef107f372f18a074b.tif
m8-76c43508fc007bcf5902b6a28e8055a5.tif
m8-f0d7bcb90496c323c880a9773dfe93ff.tif
m9-76c43508fc007bcf5902b6a28e8055a5.tif
m9-f0d7bcb90496c323c880a9773dfe93ff.tif
"""

proc hasManifestFile(manifest, fileName: string): bool =
  for line in manifest.splitLines:
    let name = line.strip()
    if name.len == 0 or name.startsWith("#"):
      continue
    if name == fileName:
      return true

proc expectedFor(kind, path: string): Expectation =
  let fileName = path.splitPath.tail

  if kind == "gif":
    for (name, expectation) in gifExpectations:
      if fileName == name:
        return expectation
    raise newException(ValueError, "Missing GIF expectation for " & fileName)

  if kind == "jpg":
    for (name, expectation) in jpgExpectations:
      if fileName == name:
        return expectation
    raise newException(ValueError, "Missing JPG expectation for " & fileName)

  if kind == "png":
    if pngShouldDecode.hasManifestFile(fileName):
      return shouldDecode
    if pngShouldNotCrash.hasManifestFile(fileName):
      return shouldNotCrash
    return shouldReject

  if kind == "tif":
    if tiffShouldDecode.hasManifestFile(fileName):
      return shouldDecode
    if tiffShouldNotCrash.hasManifestFile(fileName):
      return shouldNotCrash
    return shouldReject

  shouldDecode

proc sortedFiles(dir, pattern: string): seq[string] =
  for path in walkFiles(dir / pattern):
    result.add(path)
  result.sort()

proc checkDimensions(
  stats: var TestStats,
  path: string,
  width, height: int,
  dimensions: ImageDimensions
) =
  if width != dimensions.width or height != dimensions.height:
    stats.failures.add(&"{path}: decoded {width}x{height}, dimensions " &
      &"{dimensions.width}x{dimensions.height}")

template writeImageTestSuiteImage(kind, path: string, image: untyped) =
  when defined(writeImages):
    let dirName =
      case kind
      of "jpg":
        "jpeg"
      of "tif":
        "tiff"
      else:
        kind
    image.writeOutputImage(imageTestSuiteOutputDir / dirName, path)

proc checkGif(stats: var TestStats, path: string) =
  let data = readFile(path)
  let
    gif = decodeGif(data)
    image = newImage(gif)
    dimensions = decodeGifDimensions(data)
  stats.checkDimensions(path, image.width, image.height, dimensions)
  writeImageTestSuiteImage("gif", path, image)

proc checkJpeg(stats: var TestStats, path: string) =
  let data = readFile(path)
  let
    image = decodeJpeg(data)
    dimensions = decodeJpegDimensions(data)
  stats.checkDimensions(path, image.width, image.height, dimensions)
  writeImageTestSuiteImage("jpg", path, image)

proc checkPng(stats: var TestStats, path: string) =
  let data = readFile(path)
  let
    dimensions = decodePngDimensions(data)
    image = decodePng(data).convertToImage()
  stats.checkDimensions(path, image.width, image.height, dimensions)
  writeImageTestSuiteImage("png", path, image)

proc checkTiff(stats: var TestStats, path: string) =
  let data = readFile(path)
  let
    dimensions = decodeTiffDimensions(data)
    image = decodeTiff(data).convertToImage()
  stats.checkDimensions(path, image.width, image.height, dimensions)
  writeImageTestSuiteImage("tif", path, image)

proc checkOne(kind, path: string) =
  var stats: TestStats
  case kind
  of "gif":
    stats.checkGif(path)
  of "jpg":
    stats.checkJpeg(path)
  of "png":
    stats.checkPng(path)
  of "tif":
    stats.checkTiff(path)
  else:
    raise newException(ValueError, "Unknown image test kind " & kind)

  if stats.failures.len > 0:
    raise newException(ValueError, stats.failures.join("; "))

proc lastNonEmptyLine(text: string): string =
  for line in text.splitLines:
    let line = line.strip()
    if line.len > 0:
      result = line

proc runOne(kind, path: string): RunResult =
  let
    cmd = quoteShell(getAppFilename()) & " " & quoteShell(kind) & " " &
      quoteShell(path)
    (output, exitCode) = execCmdEx(cmd)

  let message = output.lastNonEmptyLine()
  if exitCode == 0:
    result.status = decoded
  elif message.startsWith("PixieError:"):
    result.status = rejected
    result.message = message
  else:
    result.status = failed
    if message.len > 0:
      result.message = message
    else:
      result.message = "exit code " & $exitCode

proc failedExpectation(
  path: string,
  expectation: Expectation,
  runResult: RunResult
): string =
  case expectation
  of shouldDecode:
    case runResult.status
    of decoded:
      discard
    of rejected:
      result = &"{path}: expected decode, rejected with {runResult.message}"
    of failed:
      result = &"{path}: expected decode, failed with {runResult.message}"

  of shouldReject:
    case runResult.status
    of decoded:
      result = &"{path}: decoded, expected PixieError"
    of rejected:
      discard
    of failed:
      result = &"{path}: expected PixieError, failed with {runResult.message}"

  of shouldNotCrash:
    if runResult.status == failed:
      result = &"{path}: expected decode or PixieError, failed with " &
        runResult.message

proc checkFiles(
  stats: var TestStats,
  dir, pattern, label: string,
  kind: string
) =
  let files = sortedFiles(imageTestSuitePath / dir, pattern)
  if kind == "png" and files.len != pngExpectedFileCount:
    raise newException(
      ValueError,
      &"PNG expectation manifest covers {pngExpectedFileCount} files, " &
        &"found {files.len}"
    )
  if kind == "tif" and files.len != tiffExpectedFileCount:
    raise newException(
      ValueError,
      &"TIFF expectation manifest covers {tiffExpectedFileCount} files, " &
        &"found {files.len}"
    )

  let passedBefore = stats.passed
  let failuresBefore = stats.failures.len
  echo &"{label}: {files.len} files"

  for path in files:
    inc stats.total
    let
      expectation = expectedFor(kind, path)
      runResult = runOne(kind, path)
      failure = failedExpectation(path, expectation, runResult)
    if failure.len == 0:
      inc stats.passed
    else:
      stats.failures.add(failure)

  echo &"{label}: {stats.passed - passedBefore}/{files.len} passed, " &
    &"{stats.failures.len - failuresBefore} failed"

if paramCount() == 2:
  try:
    checkOne(paramStr(1), paramStr(2))
  except Exception as exc:
    echo &"{exc.name}: {exc.msg}"
    quit(1)
  quit(0)

if not dirExists(imageTestSuitePath):
  echo &"Skipping imagetestsuite: {imageTestSuitePath} was not found"
else:
  when defined(writeImages):
    resetOutputDir(imageTestSuiteOutputDir)
    echo &"Writing decoded ImageTestSuite images to {imageTestSuiteOutputDir}"

  var stats: TestStats
  stats.checkFiles("gif", "*.gif", "GIF", "gif")
  stats.checkFiles("jpg", "*.jpg", "JPG", "jpg")
  stats.checkFiles("png", "*.png", "PNG", "png")
  stats.checkFiles("tif", "*.tif", "TIF", "tif")

  echo &"imagetestsuite: {stats.passed}/{stats.total} passed"

  if stats.failures.len > 0:
    echo &"Failures ({stats.failures.len}):"
    for failure in stats.failures:
      echo "  " & failure
    quit(1)
