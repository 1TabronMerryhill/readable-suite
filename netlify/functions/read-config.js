/* Public client config for the dashboard: Supabase URL + anon key.
   Both are public by design (the anon key ships in client JS).
   Never put the service_role key here. */

exports.handler = async function () {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({
      url: process.env.SUPABASE_URL || "",
      anonKey: process.env.SUPABASE_ANON_KEY || ""
    })
  };
};
