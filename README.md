# SCP:SL il2cpp-autodump

auto-patching and dumping tool for SCP: Secret Laboratory metadata. detects the file version, tests candidates and runs Il2CppDumper without any manual work.

made by **Kernel**

---

## what it does

SCP:SL uses Unity's il2cpp backend which stores code metadata in `global-metadata.dat`. to dump classes/methods/fields with Il2CppDumper, the version field in the file header needs to match the actual structure inside — often it doesn't and the dumper just errors out.

this script:
- auto-detects SCP:SL folder through Steam (no path needed)
- reads and analyzes the metadata header
- tests all possible format versions one by one against the actual dumper
- patches a single field and runs the dump
- archives previous dumps automatically

---

## requirements

- [Node.js](https://nodejs.org) v18+
- [Il2CppDumper](https://github.com/Perfare/Il2CppDumper/releases) — put the exe in `il2cpp_dumper/`

```
il2cpp-autodump/
├── auto-dump.js
├── il2cpp_dumper/
│   └── Il2CppDumper.exe
└── dumps/
```

---

## usage

**no arguments** — script finds SCP:SL automatically through Steam:
```bash
node auto-dump.js
```

**manual path:**
```bash
node auto-dump.js "C:\SteamLibrary\steamapps\common\SCP Secret Laboratory"
```

**flags:**
```
-v / --verbose    more logs
-q / --quiet      errors only
```

---

## output

after a successful dump everything lands in `dumps/scpsl_YYYYMMDD_HHMMSS/`:

```
dumps/
└── scpsl_20250504_143022/
    ├── DummyDll/              # dummy assemblies
    ├── dump.cs                # all classes and methods
    ├── il2cpp.h               # C++ structs
    ├── script.json
    ├── dump_info.json         # patch info
    └── global-metadata.patched.dat
```

old dumps go to `dumps/__archive__/` automatically, keeps max 15.

---

## how version detection works

the script generates a list of candidates based on:
- versions officially supported by Il2CppDumper
- the original version read from the file
- values found in the first 1024 bytes of the file

for each candidate:
1. copies the file to a temp folder
2. patches the `version` field at offset `0x04`
3. runs Il2CppDumper and checks the output
4. if the dump is complete (`DummyDll` + `dump.cs` + `il2cpp.h`) — done
5. if not — moves to the next candidate

---

## dump_info.json

```json
{
  "by": "Kernel",
  "timestamp": "2025-05-04T14:30:22.000Z",
  "originalVersion": 23,
  "patchedVersion": 29,
  "partial": false,
  "tested": 14,
  "results": [
    { "version": 23, "success": false, "dllCount": 0 },
    { "version": 29, "success": true,  "dllCount": 312 }
  ]
}
```

---

## known issues

- Windows only (Steam detection via VDF)

---

## license

personal use only. use at your own risk.
