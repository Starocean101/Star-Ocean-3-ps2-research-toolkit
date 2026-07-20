/* Generated from SO3_RESOURCE_GRAPH.json. Do not edit by hand. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SO3V58ModelIndex = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return Object.freeze({
  "actors": [
    {
      "actor_id": "0x0001",
      "assembly_state": "PARTIAL",
      "component_counts": {
        "animation": 1,
        "geometry": 0,
        "other": 0,
        "skeleton": 0
      },
      "node": "actor:0x0001",
      "resources": [
        {
          "animation_slot": null,
          "entry": 2902,
          "index": 6,
          "node": "child:2902:0x000000:6",
          "offset": "0xF0C8",
          "parsed": [],
          "res_id": "0x00320001",
          "stored_size": 11700,
          "tag": "ANIM"
        }
      ]
    },
    {
      "actor_id": "0x08FF",
      "assembly_state": "COMPONENT_COMPLETE_WITH_ANIMATION",
      "component_counts": {
        "animation": 6,
        "geometry": 1,
        "other": 0,
        "skeleton": 1
      },
      "node": "actor:0x08FF",
      "resources": [
        {
          "animation_slot": "0x0000",
          "entry": 1745,
          "index": 0,
          "node": "child:1745:0x000000:0",
          "offset": "0x000090",
          "parsed": [
            {
              "format_kind": "geometry_sample",
              "kind": "geometry_validated_as",
              "metrics": {
                "decoded_size": 136496,
                "packets": 99,
                "segments": 2,
                "skinned_verts": 2188,
                "tris": 1292,
                "verts": 2188
              },
              "node": "geom:CHAR:0x000008FF:136496"
            }
          ],
          "res_id": "0x000008FF",
          "stored_size": 62208,
          "tag": "CHAR"
        },
        {
          "animation_slot": "0x0000",
          "entry": 1745,
          "index": 1,
          "node": "child:1745:0x000000:1",
          "offset": "0x00F390",
          "parsed": [
            {
              "format_kind": "rta_skeleton",
              "kind": "parsed_as",
              "metrics": {
                "node_count": 33
              },
              "node": "rta:1745_000000000800000_ATRC_000008FF"
            }
          ],
          "res_id": "0x000008FF",
          "stored_size": 2040,
          "tag": "ATRC"
        },
        {
          "animation_slot": "0x0020",
          "entry": 1745,
          "index": 2,
          "node": "child:1745:0x000000:2",
          "offset": "0x00FB88",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Bip01"
              },
              "node": "fas:1745_000000000800000_ANIM_002008FF"
            }
          ],
          "res_id": "0x002008FF",
          "stored_size": 4008,
          "tag": "ANIM"
        },
        {
          "animation_slot": "0x002A",
          "entry": 1745,
          "index": 3,
          "node": "child:1745:0x000000:3",
          "offset": "0x010B30",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Bip01"
              },
              "node": "fas:1745_000000000800000_ANIM_002A08FF"
            }
          ],
          "res_id": "0x002A08FF",
          "stored_size": 4664,
          "tag": "ANIM"
        },
        {
          "animation_slot": "0x002B",
          "entry": 1745,
          "index": 4,
          "node": "child:1745:0x000000:4",
          "offset": "0x011D68",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Bip01"
              },
              "node": "fas:1745_000000000800000_ANIM_002B08FF"
            }
          ],
          "res_id": "0x002B08FF",
          "stored_size": 5000,
          "tag": "ANIM"
        },
        {
          "animation_slot": "0x002E",
          "entry": 1745,
          "index": 5,
          "node": "child:1745:0x000000:5",
          "offset": "0x0130F0",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Bip01"
              },
              "node": "fas:1745_000000000800000_ANIM_002E08FF"
            }
          ],
          "res_id": "0x002E08FF",
          "stored_size": 3696,
          "tag": "ANIM"
        },
        {
          "animation_slot": "0x0021",
          "entry": 1745,
          "index": 6,
          "node": "child:1745:0x000000:6",
          "offset": "0x013F60",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Bip01"
              },
              "node": "fas:1745_000000000800000_ANIM_002108FF"
            }
          ],
          "res_id": "0x002108FF",
          "stored_size": 6644,
          "tag": "ANIM"
        },
        {
          "animation_slot": "0x0082",
          "entry": 1745,
          "index": 7,
          "node": "child:1745:0x000000:7",
          "offset": "0x015954",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Bip01"
              },
              "node": "fas:1745_000000000800000_ANIM_008208FF"
            }
          ],
          "res_id": "0x008208FF",
          "stored_size": 10608,
          "tag": "ANIM"
        }
      ]
    },
    {
      "actor_id": "0x0BC0",
      "assembly_state": "COMPONENT_COMPLETE_WITH_ANIMATION",
      "component_counts": {
        "animation": 7,
        "geometry": 1,
        "other": 0,
        "skeleton": 1
      },
      "node": "actor:0x0BC0",
      "resources": [
        {
          "animation_slot": "0x0000",
          "entry": 1082,
          "index": 4,
          "node": "child:1082:0x000000:4",
          "offset": "0x02411C",
          "parsed": [
            {
              "format_kind": "geometry_sample",
              "kind": "geometry_validated_as",
              "metrics": {
                "decoded_size": 133600,
                "packets": 113,
                "segments": 2,
                "skinned_verts": 2524,
                "tris": 1476,
                "verts": 2524
              },
              "node": "geom:CHAR:0x00000BC0:133600"
            }
          ],
          "res_id": "0x00000BC0",
          "stored_size": 64644,
          "tag": "CHAR"
        },
        {
          "animation_slot": "0x0000",
          "entry": 1082,
          "index": 5,
          "node": "child:1082:0x000000:5",
          "offset": "0x033DA0",
          "parsed": [
            {
              "format_kind": "rta_skeleton",
              "kind": "parsed_as",
              "metrics": {
                "node_count": 22
              },
              "node": "rta:1082_000000000D00000_ATRC_00000BC0"
            }
          ],
          "res_id": "0x00000BC0",
          "stored_size": 1352,
          "tag": "ATRC"
        },
        {
          "animation_slot": "0x0020",
          "entry": 1082,
          "index": 6,
          "node": "child:1082:0x000000:6",
          "offset": "0x0342E8",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Bip01"
              },
              "node": "fas:1082_000000000D00000_ANIM_00200BC0"
            }
          ],
          "res_id": "0x00200BC0",
          "stored_size": 3332,
          "tag": "ANIM"
        },
        {
          "animation_slot": "0x002A",
          "entry": 1082,
          "index": 7,
          "node": "child:1082:0x000000:7",
          "offset": "0x034FEC",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Bip01"
              },
              "node": "fas:1082_000000000D00000_ANIM_002A0BC0"
            }
          ],
          "res_id": "0x002A0BC0",
          "stored_size": 3820,
          "tag": "ANIM"
        },
        {
          "animation_slot": "0x002B",
          "entry": 1082,
          "index": 8,
          "node": "child:1082:0x000000:8",
          "offset": "0x035ED8",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Bip01"
              },
              "node": "fas:1082_000000000D00000_ANIM_002B0BC0"
            }
          ],
          "res_id": "0x002B0BC0",
          "stored_size": 2948,
          "tag": "ANIM"
        },
        {
          "animation_slot": "0x002E",
          "entry": 1082,
          "index": 9,
          "node": "child:1082:0x000000:9",
          "offset": "0x036A5C",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Bip01"
              },
              "node": "fas:1082_000000000D00000_ANIM_002E0BC0"
            }
          ],
          "res_id": "0x002E0BC0",
          "stored_size": 3608,
          "tag": "ANIM"
        },
        {
          "animation_slot": "0x0021",
          "entry": 1082,
          "index": 10,
          "node": "child:1082:0x000000:10",
          "offset": "0x037874",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Bip01"
              },
              "node": "fas:1082_000000000D00000_ANIM_00210BC0"
            }
          ],
          "res_id": "0x00210BC0",
          "stored_size": 8060,
          "tag": "ANIM"
        },
        {
          "animation_slot": "0x03E8",
          "entry": 1082,
          "index": 11,
          "node": "child:1082:0x000000:11",
          "offset": "0x0397F0",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Plane01"
              },
              "node": "fas:1082_000000000D00000_ANIM_03E80BC0"
            }
          ],
          "res_id": "0x03E80BC0",
          "stored_size": 10800,
          "tag": "ANIM"
        },
        {
          "animation_slot": "0x03E9",
          "entry": 1082,
          "index": 12,
          "node": "child:1082:0x000000:12",
          "offset": "0x03C220",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Plane01"
              },
              "node": "fas:1082_000000000D00000_ANIM_03E90BC0"
            }
          ],
          "res_id": "0x03E90BC0",
          "stored_size": 4176,
          "tag": "ANIM"
        }
      ]
    },
    {
      "actor_id": "0x0FD2",
      "assembly_state": "COMPONENT_COMPLETE_WITH_ANIMATION",
      "component_counts": {
        "animation": 5,
        "geometry": 1,
        "other": 0,
        "skeleton": 1
      },
      "node": "actor:0x0FD2",
      "resources": [
        {
          "animation_slot": "0x0000",
          "entry": 1084,
          "index": 0,
          "node": "child:1084:0x000000:0",
          "offset": "0x000080",
          "parsed": [
            {
              "format_kind": "geometry_sample",
              "kind": "geometry_validated_as",
              "metrics": {
                "decoded_size": 140592,
                "packets": 119,
                "segments": 2,
                "skinned_verts": 2656,
                "tris": 1490,
                "verts": 2656
              },
              "node": "geom:CHAR:0x00000FD2:140592"
            }
          ],
          "res_id": "0x00000FD2",
          "stored_size": 65444,
          "tag": "CHAR"
        },
        {
          "animation_slot": "0x0000",
          "entry": 1084,
          "index": 1,
          "node": "child:1084:0x000000:1",
          "offset": "0x010024",
          "parsed": [
            {
              "format_kind": "rta_skeleton",
              "kind": "parsed_as",
              "metrics": {
                "node_count": 36
              },
              "node": "rta:1084_000000000700000_ATRC_00000FD2"
            }
          ],
          "res_id": "0x00000FD2",
          "stored_size": 2208,
          "tag": "ATRC"
        },
        {
          "animation_slot": "0x0020",
          "entry": 1084,
          "index": 2,
          "node": "child:1084:0x000000:2",
          "offset": "0x0108C4",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Direct01"
              },
              "node": "fas:1084_000000000700000_ANIM_00200FD2"
            }
          ],
          "res_id": "0x00200FD2",
          "stored_size": 7740,
          "tag": "ANIM"
        },
        {
          "animation_slot": "0x0021",
          "entry": 1084,
          "index": 3,
          "node": "child:1084:0x000000:3",
          "offset": "0x012700",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Direct01"
              },
              "node": "fas:1084_000000000700000_ANIM_00210FD2"
            }
          ],
          "res_id": "0x00210FD2",
          "stored_size": 12196,
          "tag": "ANIM"
        },
        {
          "animation_slot": "0x002A",
          "entry": 1084,
          "index": 4,
          "node": "child:1084:0x000000:4",
          "offset": "0x0156A4",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Direct01"
              },
              "node": "fas:1084_000000000700000_ANIM_002A0FD2"
            }
          ],
          "res_id": "0x002A0FD2",
          "stored_size": 6936,
          "tag": "ANIM"
        },
        {
          "animation_slot": "0x002B",
          "entry": 1084,
          "index": 5,
          "node": "child:1084:0x000000:5",
          "offset": "0x0171BC",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Direct01"
              },
              "node": "fas:1084_000000000700000_ANIM_002B0FD2"
            }
          ],
          "res_id": "0x002B0FD2",
          "stored_size": 7560,
          "tag": "ANIM"
        },
        {
          "animation_slot": "0x002E",
          "entry": 1084,
          "index": 6,
          "node": "child:1084:0x000000:6",
          "offset": "0x018F44",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "Direct01"
              },
              "node": "fas:1084_000000000700000_ANIM_002E0FD2"
            }
          ],
          "res_id": "0x002E0FD2",
          "stored_size": 5260,
          "tag": "ANIM"
        }
      ]
    },
    {
      "actor_id": "0x2337",
      "assembly_state": "PARTIAL",
      "component_counts": {
        "animation": 1,
        "geometry": 1,
        "other": 0,
        "skeleton": 0
      },
      "node": "actor:0x2337",
      "resources": [
        {
          "animation_slot": null,
          "entry": 2902,
          "index": 7,
          "node": "child:2902:0x000000:7",
          "offset": "0x11E7C",
          "parsed": [],
          "res_id": "0x00002337",
          "stored_size": 6736,
          "tag": "CHAR"
        },
        {
          "animation_slot": null,
          "entry": 2902,
          "index": 8,
          "node": "child:2902:0x000000:8",
          "offset": "0x138CC",
          "parsed": [],
          "res_id": "0x00002337",
          "stored_size": 708,
          "tag": "ANIM"
        }
      ]
    },
    {
      "actor_id": "0x2338",
      "assembly_state": "PARTIAL",
      "component_counts": {
        "animation": 3,
        "geometry": 1,
        "other": 0,
        "skeleton": 0
      },
      "node": "actor:0x2338",
      "resources": [
        {
          "animation_slot": null,
          "entry": 2876,
          "index": 0,
          "node": "child:2876:0x000000:0",
          "offset": "0x50",
          "parsed": [],
          "res_id": "0x00002338",
          "stored_size": 1180,
          "tag": "CHAR"
        },
        {
          "animation_slot": null,
          "entry": 2876,
          "index": 1,
          "node": "child:2876:0x000000:1",
          "offset": "0x4EC",
          "parsed": [],
          "res_id": "0x00002338",
          "stored_size": 184,
          "tag": "ANIM"
        },
        {
          "animation_slot": null,
          "entry": 2876,
          "index": 2,
          "node": "child:2876:0x000000:2",
          "offset": "0x5A4",
          "parsed": [],
          "res_id": "0x03212338",
          "stored_size": 212,
          "tag": "ANIM"
        },
        {
          "animation_slot": null,
          "entry": 2876,
          "index": 3,
          "node": "child:2876:0x000000:3",
          "offset": "0x678",
          "parsed": [],
          "res_id": "0x03222338",
          "stored_size": 220,
          "tag": "ANIM"
        }
      ]
    },
    {
      "actor_id": "0x9D63",
      "assembly_state": "COMPONENT_COMPLETE_WITH_ANIMATION",
      "component_counts": {
        "animation": 2,
        "geometry": 1,
        "other": 0,
        "skeleton": 1
      },
      "node": "actor:0x9D63",
      "resources": [
        {
          "animation_slot": null,
          "entry": 2902,
          "index": 2,
          "node": "child:2902:0x000000:2",
          "offset": "0x9474",
          "parsed": [],
          "res_id": "0x00009D63",
          "stored_size": 20952,
          "tag": "CHAR"
        },
        {
          "animation_slot": null,
          "entry": 2902,
          "index": 3,
          "node": "child:2902:0x000000:3",
          "offset": "0xE64C",
          "parsed": [],
          "res_id": "0x00079D63",
          "stored_size": 156,
          "tag": "ATRC"
        },
        {
          "animation_slot": null,
          "entry": 2902,
          "index": 4,
          "node": "child:2902:0x000000:4",
          "offset": "0xE6E8",
          "parsed": [],
          "res_id": "0x00209D63",
          "stored_size": 1452,
          "tag": "ANIM"
        },
        {
          "animation_slot": null,
          "entry": 2902,
          "index": 5,
          "node": "child:2902:0x000000:5",
          "offset": "0xEC94",
          "parsed": [],
          "res_id": "0x00219D63",
          "stored_size": 1076,
          "tag": "ANIM"
        }
      ]
    },
    {
      "actor_id": "0xF800",
      "assembly_state": "COMPONENT_COMPLETE_STATIC",
      "component_counts": {
        "animation": 0,
        "geometry": 1,
        "other": 0,
        "skeleton": 1
      },
      "node": "actor:0xF800",
      "resources": [
        {
          "animation_slot": "0x0000",
          "entry": 1082,
          "index": 0,
          "node": "child:1082:0x000000:0",
          "offset": "0x0000E0",
          "parsed": [
            {
              "format_kind": "geometry_sample",
              "kind": "geometry_validated_as",
              "metrics": {
                "decoded_size": 147088,
                "packets": 10,
                "segments": 4,
                "skinned_verts": 0,
                "tris": 126,
                "verts": 266
              },
              "node": "geom:CHAR:0x0000F800:147088"
            }
          ],
          "res_id": "0x0000F800",
          "stored_size": 110952,
          "tag": "CHAR"
        },
        {
          "animation_slot": "0x0000",
          "entry": 1082,
          "index": 1,
          "node": "child:1082:0x000000:1",
          "offset": "0x01B248",
          "parsed": [
            {
              "format_kind": "rta_skeleton",
              "kind": "parsed_as",
              "metrics": {
                "node_count": 3
              },
              "node": "rta:1082_000000000D00000_ATRC_0000F800"
            }
          ],
          "res_id": "0x0000F800",
          "stored_size": 236,
          "tag": "ATRC"
        }
      ]
    },
    {
      "actor_id": "0xF80C",
      "assembly_state": "PARTIAL",
      "component_counts": {
        "animation": 2,
        "geometry": 2,
        "other": 0,
        "skeleton": 0
      },
      "node": "actor:0xF80C",
      "resources": [
        {
          "animation_slot": "0x0000",
          "entry": 1082,
          "index": 2,
          "node": "child:1082:0x000000:2",
          "offset": "0x01B334",
          "parsed": [
            {
              "format_kind": "geometry_sample",
              "kind": "geometry_validated_as",
              "metrics": {
                "decoded_size": 65072,
                "packets": 37,
                "segments": 6,
                "skinned_verts": 0,
                "tris": 1056,
                "verts": 1292
              },
              "node": "geom:CHAR:0x0000F80C:65072"
            }
          ],
          "res_id": "0x0000F80C",
          "stored_size": 33184,
          "tag": "CHAR"
        },
        {
          "animation_slot": "0x0000",
          "entry": 1082,
          "index": 3,
          "node": "child:1082:0x000000:3",
          "offset": "0x0234D4",
          "parsed": [
            {
              "format_kind": "fas_clip",
              "kind": "parsed_as",
              "metrics": {
                "empty": false,
                "target_skeleton": "DummyRotation"
              },
              "node": "fas:1082_000000000D00000_ANIM_0000F80C"
            }
          ],
          "res_id": "0x0000F80C",
          "stored_size": 3144,
          "tag": "ANIM"
        },
        {
          "animation_slot": null,
          "entry": 2902,
          "index": 0,
          "node": "child:2902:0x000000:0",
          "offset": "0xA0",
          "parsed": [],
          "res_id": "0x0000F80C",
          "stored_size": 34700,
          "tag": "CHAR"
        },
        {
          "animation_slot": null,
          "entry": 2902,
          "index": 1,
          "node": "child:2902:0x000000:1",
          "offset": "0x882C",
          "parsed": [],
          "res_id": "0x0000F80C",
          "stored_size": 3144,
          "tag": "ANIM"
        }
      ]
    },
    {
      "actor_id": "0xF900",
      "assembly_state": "PARTIAL",
      "component_counts": {
        "animation": 0,
        "geometry": 1,
        "other": 0,
        "skeleton": 0
      },
      "node": "actor:0xF900",
      "resources": [
        {
          "animation_slot": null,
          "entry": 1943,
          "index": 0,
          "node": "child:1943:0x000000:0",
          "offset": "0x30",
          "parsed": [],
          "res_id": "0x0000F900",
          "stored_size": 12688,
          "tag": "CHAR"
        }
      ]
    }
  ],
  "association_confidence": {
    "embedded_fis_membership": "VERIFIED_BY_CHAIN_BOUNDARY",
    "fas_channel_to_rta_node_by_name": "VERIFIED_ON_PAIRED_SAMPLES",
    "material_to_texture_assignment": "UNRESOLVED",
    "resource_id_low16_grouping": "STRONG_INFERENCE",
    "xbdc_matrix_address_to_rta_node": "UNRESOLVED_ORDINAL_CANDIDATE_ONLY"
  },
  "atlas_version": "1.1.1",
  "counts": {
    "actors": 10,
    "component_complete": 5,
    "component_complete_with_animation": 4,
    "resources": 42
  },
  "format": "SO3_MODEL_ASSET_INDEX_V1",
  "source_graph_sha256": "d3313df537954864a6d50448801cc7e73678391ebae9b637b92c16c542fda6de",
  "version": 1
});
});
