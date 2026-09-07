/** Target choices are committed only by Chapter Apply review. */
export async function PATCH() {
  return Response.json({ error: "Stage Privacy choices in the Chapter, then Apply review." }, {
    status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" },
  });
}
