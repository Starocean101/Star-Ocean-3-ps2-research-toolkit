# V5.8 model assembly and asset-catalogue pass

## Outcome

V5.8 can group indexed actor resources, parse geometry and RTA/FAS components,
decode embedded texture images, render a diagnostic mesh, and export a single
evidence package. It also adds stable per-disc asset IDs and a separate human
label layer for later script and dependency research.

## New verified parser repairs

### Embedded FIS/FISA size

The u32 at section `+0x04` is the byte count after the leading 0x10 bytes. The
complete section length is therefore:

```text
total_size = stored_size + 0x10
```

The previous viewer used `stored_size` as the total and truncated every image
by 16 bytes. The corrected rule decodes all six FIS images in actor `0x0BC0`.

### RTA off1 V2 name records

After the lead qword at `off1`, each node has one fixed 0x14-byte record:

```text
+0x00 f32       auxiliary scalar (semantic role unresolved)
+0x04 char[16]  CP932 node name, NUL-padded when shorter than 16 bytes
```

Names occupying all 16 bytes have no terminator. Fixed-width parsing recovers
all 22 `0x0BC0` names and avoids merging a name with the next scalar.

## Assembly grades

- `FULLY_RENDERABLE_RIGID`: validated FLOAT geometry can be rendered without a
  skeleton mapping.
- `COMPONENT_COMPLETE_DIAGNOSTIC`: geometry, textures, and RTA/FAS components
  are present, but unresolved runtime links prevent a final skinned export.
- `PARTIAL_*`: one or more components are absent.

Actor `0x0BC0` is `COMPONENT_COMPLETE_DIAGNOSTIC`.

## Runtime links deliberately not applied

1. `U-GEO-01`: matrix address → RTA node. Addresses 656..740, stride 4, have
   exact cardinality with the 22 RTA nodes. Ordinal pairing is a strong
   candidate, not verified execution evidence.
2. TEX0 runtime patch ID → embedded FIS image. Observed candidates `0x0B35` and
   `0x0A3D` do not directly equal FIS IDs 1294/1295/1296/2414/2415/3362.
3. FAS rotation evaluation. Channel layout and exact-name binding are known;
   quaternion role, interpolation, and one quantized sign rule remain open.

## Export contents

`SO3_V58_MODEL_ASSEMBLY_*.zip` contains:

- `SO3_MODEL_ASSEMBLY_V1.json`;
- a clearly marked packet-local diagnostic OBJ;
- RTA diagnostic hierarchy JSON;
- unapplied matrix-address candidates;
- unresolved material/FISA tables; and
- one PNG per FIS palette-bank variant.

No exported filename or manifest calls the XBDC result a verified final skinned
model.
