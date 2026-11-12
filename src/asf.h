#ifndef ASF_H
#define ASF_H
#include <stddef.h>
#include <stdint.h>

/* tri-Ace ASKA ASF model -> glTF 2.0 binary. */
typedef struct {
    uint32_t meshes, skipped, textures;
    uint64_t vertices, triangles, bytes;
} AsfStats;

int    asf_is(const uint8_t *head, size_t n);               /* starts with the ASF tag */
/* Decode the compressed index stream (u16 words incl. the leading H) into a triangle
 * list. Returns the number of indices written (<= cap). */
size_t asf_decode_indices(const uint16_t *words, size_t nwords, uint16_t *out, size_t cap);
/* Convert a whole ASF held in memory to out_path (.glb). 0 ok, -1 error (err). */
typedef struct {
    uint32_t nv, ni;
    float   *pos, *nrm, *uv;   /* nv*3, nv*3 (or NULL), nv*2 (or NULL) */
    uint16_t *ind;             /* ni, counter-clockwise triangles */
    int      tex;              /* index into tex[], -1 = none */
    float    mn[3], mx[3];
} AsfMesh;
typedef struct { uint32_t w, h; uint8_t *rgba; } AsfTex;
typedef struct {
    AsfMesh *mesh; int nmesh;
    AsfTex  *tex;  int ntex;
    float    mn[3], mx[3];
    AsfStats st;
} AsfModel;
AsfModel *asf_load(const uint8_t *data, size_t n, int want_textures, char *err, size_t en);
void      asf_free(AsfModel *m);
/* Viewer only: hide shadow/collision hulls and an enclosing sky dome. Returns the count. */
int       asf_view_prepare(AsfModel *m);
int       asf_model_to_glb(const AsfModel *m, const char *out_path, AsfStats *st, char *err, size_t en);
int    asf_to_glb(const uint8_t *data, size_t n, const char *out_path, AsfStats *st, char *err, size_t en);

#endif
