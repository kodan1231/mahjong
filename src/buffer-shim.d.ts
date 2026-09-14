// nodejs_compat有効時、実行時にはBufferが本物のクラスとしてグローバルに存在するが、
// @types/nodeはWorkers標準API（fetch/Response等）の型と衝突しやすいため導入しない。
// ここではdrizzle-ormのblob(mode:"buffer")列が要求する型解決のためだけに、
// Uint8Arrayの別名として最小限のBuffer型を宣言する（アプリ側ではBuffer固有のメソッドは使わない）。
declare global {
  type Buffer = Uint8Array;
}

export {};
