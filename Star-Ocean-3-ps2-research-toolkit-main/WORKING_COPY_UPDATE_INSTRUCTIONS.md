# Updating through Working Copy on iPhone

1. Open the existing repository in Working Copy.
2. Create a branch named `release/v5.12.8-pass6.2`.
3. Import the contents of the returned repository ZIP into the repository root,
   allowing matching files to be replaced.
4. Confirm that no `.iso`, `.elf`, `.irx`, extracted actor resource, or private
   evidence directory appears in the staged change list.
5. Commit with:

   `Publish SO3 Resource Explorer V5.12.8 Pass 6.2`

6. Push the branch.
7. On GitHub, compare the branch with `main`, review the file list, and merge.
8. Optionally create release tag `v5.12.8-pass6.2` and attach the separately
   supplied public release ZIP.

The repository ZIP does not contain `.git`; Working Copy retains the existing
repository history and remote configuration.
