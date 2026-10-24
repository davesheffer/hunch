@@CLEANROOM_HOLE_1@@
    assert.ok(warning?.includes("does not pin num_ctx"), `expected an unpinned-context warning, got: ${warning}`);
    assert.ok(!warning?.includes("4096"), `must not guess the server's effective context: ${warning}`);
@@CLEANROOM_HOLE_2@@
