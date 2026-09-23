use anyhow::Result;
use substreams_ethereum::Abigen;

fn main() -> Result<()> {
    println!("cargo:rerun-if-changed=abi/relaunch_factory.json");
    println!("cargo:rerun-if-changed=abi/relaunch_bonding_curve.json");
    println!("cargo:rerun-if-changed=abi/graduation_router.json");
    println!("cargo:rerun-if-changed=abi/uniswap_v2_pair.json");

    Abigen::new("ReLaunchFactory", "abi/relaunch_factory.json")?
        .generate()?
        .write_to_file("src/abi/relaunch_factory.rs")?;

    Abigen::new("ReLaunchBondingCurve", "abi/relaunch_bonding_curve.json")?
        .generate()?
        .write_to_file("src/abi/relaunch_bonding_curve.rs")?;

    Abigen::new("GraduationRouter", "abi/graduation_router.json")?
        .generate()?
        .write_to_file("src/abi/graduation_router.rs")?;

    Abigen::new("UniswapV2Pair", "abi/uniswap_v2_pair.json")?
        .generate()?
        .write_to_file("src/abi/uniswap_v2_pair.rs")?;

    Ok(())
}
