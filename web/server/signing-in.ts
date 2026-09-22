/** Set on the request of a page shown to a browser that still has to sign in, so the layout
 * shows nothing about rigd. A client cannot forge it: the proxy always clears it first. */
export const SIGNING_IN_HEADER = "x-rig-signing-in";
